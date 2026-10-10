/**
 * Machine-facing API operations — the single implementation behind both the
 * REST routes (`/api/v1/*`) and the MCP tools (`/mcp`). Every function takes
 * an authenticated principal and returns `{status, body}`; authorization is
 * enforced here via scope, exactly like the UI enforces permissions.
 *
 * Scopes: 'read' sees monitoring data; 'operate' additionally mutates
 * protection (ban/unban). There is deliberately no 'configure' scope — key
 * management, user administration, and Cloudflare account changes stay UI-only.
 */
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { alert, decision, notification, site, syncState } from '#lib/server/db/app.schema.ts';
import { recordAudit } from '#lib/server/audit.ts';
import { listAlerts, listDecisions, ipDetail } from '#lib/server/crowdsec/lists.ts';
import { getServer, buildClient } from '#lib/server/crowdsec/connection.ts';
import { requestDecision, requestRemoval } from '#lib/server/crowdsec/decisions.ts';
import { normalizeTarget, parseDuration } from '#lib/ipaddr.ts';
import { APP_VERSION } from '#lib/server/ops.ts';
import type { ApiPrincipal, ApiScope } from '#lib/server/api-keys.ts';

export class ApiError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

export const need = (p: ApiPrincipal, scope: ApiScope) => {
	if (p.scope !== scope && scope === 'operate')
		throw new ApiError(403, 'This key has read scope; the operation needs an operate-scope key.');
};

const int = (v: unknown, lo: number, hi: number, fallback: number): number => {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
	return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** GET /api/v1/status — version, connectivity, projection freshness. */
export async function status(database: typeof db) {
	const server = await getServer(database);
	const sync = await database.select().from(syncState);
	const [{ alerts }] = await database.select({ alerts: sql<number>`count(*)` }).from(alert);
	return {
		version: APP_VERSION,
		connected: !!server?.machineId,
		lapiUrl: server?.lapiUrl ?? null,
		crowdsecVersion: server?.crowdsecVersion ?? null,
		alerts,
		sync: sync.map((s) => ({
			source: s.source,
			ok: !s.lastError,
			lastError: s.lastError,
			lastSuccessAt: s.lastSuccessAt,
			partial: s.partial
		}))
	};
}

export async function alerts(database: typeof db, _p: ApiPrincipal, q: URLSearchParams) {
	const sinceHours = q.get('sinceHours');
	return listAlerts(database, {
		siteId: q.get('siteId') ?? undefined,
		scenario: q.get('scenario') ?? undefined,
		ip: q.get('ip') ?? undefined,
		page: int(q.get('page'), 1, 100_000, 1),
		since: sinceHours
			? new Date(Date.now() - int(sinceHours, 1, 24 * 365, 24) * 3_600_000)
			: undefined
	});
}

export async function alertById(database: typeof db, _p: ApiPrincipal, id: string) {
	const upstreamId = Number(id);
	if (!Number.isInteger(upstreamId)) throw new ApiError(400, 'Alert id must be an integer.');
	const row = await database.query.alert.findFirst({
		where: (t, { eq }) => eq(t.upstreamId, upstreamId)
	});
	if (!row) throw new ApiError(404, 'Alert not found.');
	return row;
}

export async function decisions(database: typeof db, _p: ApiPrincipal, q: URLSearchParams) {
	return listDecisions(database, {
		q: q.get('q') ?? undefined,
		includeExpired: q.get('includeExpired') === '1' || q.get('includeExpired') === 'true',
		page: int(q.get('page'), 1, 100_000, 1)
	});
}

/**
 * POST /api/v1/decisions {action:'ban'|'captcha', ip|cidr, duration, reason?}
 * pushes via the same upstream path as the UI — the request lands in
 * decision_request and reconciles on the next sync.
 */
export async function createDecision(
	database: typeof db,
	p: ApiPrincipal,
	body: Record<string, unknown>,
	via = 'api'
) {
	need(p, 'operate');
	const action = String(body.action ?? 'ban');
	if (action !== 'ban' && action !== 'captcha')
		throw new ApiError(400, "action must be 'ban' or 'captcha'.");
	const target = normalizeTarget(String(body.ip ?? body.cidr ?? body.target ?? ''));
	if (!target) throw new ApiError(400, 'Provide a valid IPv4/IPv6 address or CIDR range.');
	const durationS = parseDuration(String(body.duration ?? '4h'));
	if (!durationS) throw new ApiError(400, 'duration must look like 4h, 90m, 2d (max 30d).');

	const client = await buildClient(database);
	if (!client) throw new ApiError(409, 'Not connected to a LAPI.');
	const res = await requestDecision(database, client, {
		...target,
		type: action,
		durationS,
		reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined,
		userId: p.userId
	});
	if (!res.ok) throw new ApiError(502, `Upstream rejected the decision: ${res.error}`);
	await recordAudit({
		actor: p.userId,
		action: 'decision.create',
		detail: { scope: target.scope, value: target.value, type: action, durationS, via }
	});
	return { state: 'requested', ...target, type: action, durationS };
}

/**
 * DELETE /api/v1/decisions {id, value?} — request removal of an active
 * decision. The projection row is authoritative for `value` — a caller that
 * passes a mismatched value can't wedge the 'removing' reconciliation row.
 */
export async function removeDecision(
	database: typeof db,
	p: ApiPrincipal,
	body: Record<string, unknown>,
	via = 'api'
) {
	need(p, 'operate');
	const upstreamId = Number(body.id ?? body.upstreamId);
	if (!Number.isInteger(upstreamId) || upstreamId <= 0)
		throw new ApiError(400, 'Provide the decision id.');
	const existing = await database
		.select({ value: decision.value })
		.from(decision)
		.where(eq(decision.upstreamId, upstreamId))
		.get();
	const value = existing?.value ?? String(body.value ?? '');
	if (!value)
		throw new ApiError(404, 'Decision not in the local projection; pass its value explicitly.');
	const client = await buildClient(database);
	if (!client) throw new ApiError(409, 'Not connected to a LAPI.');
	const res = await requestRemoval(database, client, upstreamId, value, p.userId);
	if (!res.ok) throw new ApiError(502, `Unban failed: ${res.error}`);
	await recordAudit({
		actor: p.userId,
		action: 'decision.remove',
		detail: { upstreamId, value, via }
	});
	return { state: 'removal-requested', id: upstreamId, value };
}

export async function sites(database: typeof db) {
	return database
		.select({
			id: site.id,
			hostname: site.hostname,
			proxy: site.proxy,
			runtime: site.runtime,
			source: site.source,
			cloudflare: site.cloudflare,
			wafLevel: site.wafLevel,
			detection: site.detection
		})
		.from(site)
		.orderBy(site.hostname);
}

export async function siteById(database: typeof db, _p: ApiPrincipal, id: string) {
	const row = await database.select().from(site).where(eq(site.id, id)).get();
	if (!row) throw new ApiError(404, 'Site not found.');
	return row;
}

/** GET /api/v1/lookup/<ip> — alerts + decisions + geo for one address. */
export async function lookupIp(database: typeof db, _p: ApiPrincipal, ip: string) {
	const target = normalizeTarget(ip);
	if (!target || target.scope !== 'ip') throw new ApiError(400, 'Provide a single IP address.');
	return ipDetail(database, target.value);
}

export async function notifications(database: typeof db, _p: ApiPrincipal, q: URLSearchParams) {
	const limit = int(q.get('limit'), 1, 200, 50);
	const rows = await database
		.select({
			eventKey: notification.eventKey,
			class: notification.class,
			severity: notification.severity,
			title: notification.title,
			body: notification.body,
			siteId: notification.site,
			siteHostname: site.hostname,
			count: notification.count,
			unread: sql<number>`case when ${notification.readAt} is null then 1 else 0 end`,
			createdAt: notification.createdAt,
			updatedAt: notification.lastAt
		})
		.from(notification)
		.leftJoin(site, eq(notification.site, site.id))
		.orderBy(desc(notification.lastAt))
		.limit(limit);
	return rows;
}
