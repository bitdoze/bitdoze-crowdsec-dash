/**
 * Typed CrowdSec LAPI client.
 *
 * Auth: `POST /v1/watchers/login` with machine credentials → JWT, cached
 * until just before `expire` and re-fetched once on a 401.
 *
 * Failure model: `LapiError` carries a `kind` the caller can act on —
 * 'auth' (bad credentials), 'unreachable' (DNS/TCP/TLS/timeout),
 * 'http' (unexpected status), 'bad_response' (non-JSON / wrong shape).
 * Timeouts come from AbortSignal.timeout; retries with small exponential
 * backoff cover transient 5xx/network errors.
 */
import { Agent, type Dispatcher } from 'undici';
import type { LapiAlert, WatchersLoginResponse } from './types.ts';

export type LapiErrorKind = 'auth' | 'unreachable' | 'http' | 'bad_response';

export class LapiError extends Error {
	readonly kind: LapiErrorKind;
	readonly status?: number;
	constructor(kind: LapiErrorKind, message: string, status?: number) {
		super(message);
		this.kind = kind;
		this.status = status;
	}
}

export interface LapiClientOptions {
	baseUrl: string;
	machineId: string;
	password: string;
	/** Skip TLS verification — for self-signed certs on the LAN only. */
	insecureTls?: boolean;
	timeoutMs?: number;
	retries?: number;
	/** Injectable for tests. */
	fetchImpl?: typeof fetch;
}

export interface AlertsQuery {
	/** Go duration ("90s", "4h30m", "30d") — StartedAt >= now - d. */
	since?: string;
	/** Go duration — StartedAt <= now - d. */
	until?: string;
	/** Go duration — CreatedAt <= now - d; used to page backward. */
	createdBefore?: string;
	limit?: number;
	origin?: string;
	scenario?: string;
	ip?: string;
	hasActiveDecision?: boolean;
	/** false → `simulated=false` (exclude), true → `simulated=true`; undefined sends nothing. */
	includeSimulation?: boolean;
	/** false sends include_capi=false (alerts with CAPI/lists decisions drop out). */
	includeCapi?: boolean;
	sort?: 'ASC' | 'DESC';
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRIES = 2;

export class LapiClient {
	private readonly base: string;
	private readonly opts: LapiClientOptions;
	private readonly dispatcher?: Dispatcher;
	private token: { value: string; expiresAt: number } | null = null;

	constructor(opts: LapiClientOptions) {
		this.opts = opts;
		// Trailing slashes would double in `${base}${path}`.
		this.base = opts.baseUrl.replace(/\/+$/, '');
		if (opts.insecureTls) {
			this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
		}
	}

	private get f(): typeof fetch {
		return this.opts.fetchImpl ?? fetch;
	}

	/** Public probe used by the connection test; returns the token expiry. */
	async login(): Promise<Date | null> {
		const res = await this.request<WatchersLoginResponse>({
			path: '/v1/watchers/login',
			method: 'POST',
			body: { machine_id: this.opts.machineId, password: this.opts.password },
			auth: false
		});
		if (!res.token) throw new LapiError('bad_response', 'login returned no token');
		const expiresAt = res.expire ? new Date(res.expire).getTime() : Date.now() + 60 * 60_000;
		this.token = { value: res.token, expiresAt };
		return res.expire ? new Date(res.expire) : null;
	}

	async alerts(query: AlertsQuery = {}): Promise<LapiAlert[]> {
		const params = new URLSearchParams();
		if (query.since) params.set('since', query.since);
		if (query.until) params.set('until', query.until);
		if (query.createdBefore) params.set('created_before', query.createdBefore);
		if (query.limit) params.set('limit', String(query.limit));
		if (query.origin) params.set('origin', query.origin);
		if (query.scenario) params.set('scenario', query.scenario);
		if (query.ip) params.set('ip', query.ip);
		if (query.hasActiveDecision) params.set('has_active_decision', 'true');
		if (query.includeSimulation !== undefined)
			params.set('simulated', String(query.includeSimulation));
		if (query.includeCapi === false) params.set('include_capi', 'false');
		if (query.sort) params.set('sort', query.sort);
		const qs = params.toString();
		const data = await this.request<unknown>({ path: `/v1/alerts${qs ? `?${qs}` : ''}` });
		if (data === null) return []; // LAPI returns `null` (not []) for an empty window
		if (!Array.isArray(data)) {
			throw new LapiError('bad_response', 'alerts response was not an array');
		}
		return data as LapiAlert[];
	}

	/** Bearer-key call for the optional observer bouncer credential (tier B). */
	async decisionsByIp(ip: string, bouncerKey: string): Promise<unknown> {
		const params = new URLSearchParams({ ip });
		return this.request<unknown>({
			path: `/v1/decisions?${params}`,
			authHeader: `Bearer ${bouncerKey}`
		});
	}

	/**
	 * Manual decision via `POST /v1/alerts` (tier A write): the watcher pushes
	 * an alert carrying a decision — the same mechanism `cscli decisions add`
	 * uses remotely, so the body mirrors what cscli sends (origin `cscli`,
	 * canonical Ip/Range scopes, empty events, no labels). The response is an
	 * array of created alert ids — empty when every source was allowlisted.
	 */
	async pushManualDecision(input: {
		scope: 'ip' | 'range';
		value: string;
		type: 'ban' | 'captcha';
		duration: string;
		reason?: string;
	}): Promise<unknown> {
		const now = new Date().toISOString();
		const scope = input.scope === 'ip' ? 'Ip' : 'Range';
		const reason = input.reason?.trim() || `manual ${input.type} via dashboard`;
		const body = [
			{
				capacity: 0,
				leakspeed: '0',
				events: [],
				events_count: 1,
				message: reason,
				scenario: reason,
				scenario_hash: '',
				scenario_version: '',
				simulated: false,
				source: {
					scope,
					value: input.value,
					...(input.scope === 'ip' ? { ip: input.value } : { range: input.value })
				},
				start_at: now,
				stop_at: now,
				created_at: now,
				decisions: [
					{
						type: input.type,
						scope,
						value: input.value,
						duration: input.duration,
						origin: 'cscli',
						scenario: reason
					}
				],
				remediation: true
			}
		];
		return this.request({ path: '/v1/alerts', method: 'POST', body });
	}

	/** Remove a decision by its LAPI id (tier A write). */
	async deleteDecision(decisionId: number | string): Promise<unknown> {
		return this.request({ path: `/v1/decisions/${decisionId}`, method: 'DELETE' });
	}

	/** Centralized allowlists, CrowdSec ≥1.7 (tier A read). */
	async allowlists(): Promise<unknown> {
		return this.request<unknown>({ path: '/v1/allowlists' });
	}

	/** Check whether an address is covered by a centralized allowlist. */
	async allowlistCheck(ip: string): Promise<{ allowlisted: boolean; reason: string | null }> {
		const r = await this.request<{ allowlisted?: boolean; reason?: string } | null>({
			path: `/v1/allowlists/check/${encodeURIComponent(ip)}`
		});
		return { allowlisted: r?.allowlisted === true, reason: r?.reason ?? null };
	}

	private async ensureToken(): Promise<string> {
		const now = Date.now();
		if (this.token && now < this.token.expiresAt - 30_000) return this.token.value;
		await this.login();
		return this.token!.value;
	}

	private async request<T>({
		path,
		method = 'GET',
		body,
		auth = true,
		authHeader,
		allowRetryOn401 = true
	}: {
		path: string;
		method?: string;
		body?: unknown;
		auth?: boolean;
		authHeader?: string;
		allowRetryOn401?: boolean;
	}): Promise<T> {
		const attempts = (this.opts.retries ?? DEFAULT_RETRIES) + 1;
		let lastErr: unknown;
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
			const headers: Record<string, string> = { Accept: 'application/json' };
			if (body !== undefined) headers['Content-Type'] = 'application/json';
			if (authHeader) {
				headers.Authorization = authHeader;
			} else if (auth) {
				headers.Authorization = `Bearer ${await this.ensureToken()}`;
			}
			let res: Response;
			try {
				res = await this.f(`${this.base}${path}`, {
					method,
					headers,
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
					// @ts-expect-error undici dispatcher is not in the DOM fetch type
					dispatcher: this.dispatcher
				});
			} catch (e) {
				lastErr = toLapiError(e);
				continue; // network/TLS/timeout — retryable
			}
			if (res.status === 401 || res.status === 403) {
				if (auth && allowRetryOn401 && this.token) {
					this.token = null; // stale JWT — refresh once
					return this.request({ path, method, body, auth, authHeader, allowRetryOn401: false });
				}
				throw new LapiError('auth', `LAPI returned ${res.status}`, res.status);
			}
			if (res.status === 429 || res.status >= 500) {
				lastErr = new LapiError('http', `LAPI returned ${res.status}`, res.status);
				continue;
			}
			if (!res.ok) {
				throw new LapiError('http', `LAPI returned ${res.status}`, res.status);
			}
			try {
				return (await res.json()) as T;
			} catch {
				throw new LapiError('bad_response', 'LAPI returned invalid JSON', res.status);
			}
		}
		throw lastErr instanceof Error ? lastErr : new LapiError('unreachable', String(lastErr));
	}
}

function toLapiError(e: unknown): LapiError {
	const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
	const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
	const hint = cause?.code ? ` (${cause.code})` : '';
	return new LapiError('unreachable', `${msg}${hint}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
