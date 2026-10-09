/**
 * Cloudflare API v4 client — the narrow slice the edge mode needs:
 * token verification, zone discovery, account IP lists (create/get/items/
 * bulk update/delete) and zone WAF custom rulesets. `fetch` and `baseUrl`
 * are injectable so tests can run against a stub without a network.
 */

const DEFAULT_BASE = 'https://api.cloudflare.com/client/v4';

export class CfError extends Error {
	readonly status: number;
	readonly code: number | null;
	readonly retryAfterMs: number | null;

	constructor(
		message: string,
		opts: { status?: number; code?: number | null; retryAfterMs?: number | null } = {}
	) {
		super(message);
		this.name = 'CfError';
		this.status = opts.status ?? 0;
		this.code = opts.code ?? null;
		this.retryAfterMs = opts.retryAfterMs ?? null;
	}
}

export interface CfClientOptions {
	token: string;
	baseUrl?: string;
	fetch?: typeof fetch;
}

interface CfEnvelope<T> {
	success: boolean;
	errors: { code: number; message: string }[];
	messages: unknown[];
	result: T;
	result_info?: { page?: number; count?: number; cursor?: string };
}

export interface TokenVerifyResult {
	id: string;
	status: string;
	name?: string;
	expires_on?: string | null;
	/** Permission-group names, e.g. "Zone WAF Edit". Empty when the API omits them. */
	permissionGroups: string[];
}

export interface CfZone {
	id: string;
	name: string;
	status: string;
	plan: string;
	accountId: string;
	accountName: string;
}

export interface CfList {
	id: string;
	name: string;
	kind: string;
	description?: string;
	num_items?: number;
	num_referencing_filters?: number;
}

export interface CfListItem {
	ip: string;
	comment?: string;
	created_on?: string;
	modified_on?: string;
}

export interface CfRule {
	/** Assigned by Cloudflare — absent on rules we're submitting. */
	id?: string;
	ref?: string;
	expression: string;
	action: string;
	description?: string;
	enabled?: boolean;
	action_parameters?: Record<string, unknown>;
}

export interface CfRuleset {
	id: string;
	rules: CfRule[];
}

export type BulkOperationStatus = 'pending' | 'completed' | 'failed';

export interface BulkOperation {
	id: string;
	status: BulkOperationStatus;
	error?: string;
	completed?: string;
}

export function cfClient(opts: CfClientOptions) {
	const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
	const doFetch = opts.fetch ?? fetch;

	async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
		const res = await doFetch(`${base}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${opts.token}`,
				'content-type': 'application/json',
				...(init.headers ?? {})
			}
		});
		let body: CfEnvelope<T>;
		try {
			body = (await res.json()) as CfEnvelope<T>;
		} catch {
			throw new CfError(`Cloudflare API returned non-JSON (${res.status})`, {
				status: res.status,
				retryAfterMs: retryAfterMs(res)
			});
		}
		if (!body.success) {
			const first = body.errors?.[0];
			throw new CfError(first?.message ?? `Cloudflare API error (${res.status})`, {
				status: res.status,
				code: first?.code ?? null,
				retryAfterMs: retryAfterMs(res)
			});
		}
		return body.result;
	}

	return {
		async verifyToken(): Promise<TokenVerifyResult> {
			const r = await call<{
				id: string;
				status: string;
				name?: string;
				expires_on?: string | null;
				policies?: { permission_groups?: { name?: string }[] }[];
			}>('/user/tokens/verify');
			const permissionGroups = (r.policies ?? [])
				.flatMap((p) => p.permission_groups ?? [])
				.map((g) => g.name ?? '')
				.filter(Boolean);
			return {
				id: r.id,
				status: r.status,
				name: r.name,
				expires_on: r.expires_on,
				permissionGroups: [...new Set(permissionGroups)]
			};
		},

		async listZones(): Promise<CfZone[]> {
			const zones = await call<
				{
					id: string;
					name: string;
					status: string;
					plan?: { name?: string };
					account?: { id?: string; name?: string };
				}[]
			>('/zones?per_page=50');
			return zones.map((z) => ({
				id: z.id,
				name: z.name,
				status: z.status,
				plan: z.plan?.name ?? 'unknown',
				accountId: z.account?.id ?? '',
				accountName: z.account?.name ?? ''
			}));
		},

		async listLists(accountId: string): Promise<CfList[]> {
			return call<CfList[]>(`/accounts/${accountId}/rules/lists`);
		},

		async createList(accountId: string, name: string, description: string): Promise<CfList> {
			return call<CfList>(`/accounts/${accountId}/rules/lists`, {
				method: 'POST',
				body: JSON.stringify({ name, kind: 'ip', description })
			});
		},

		async deleteList(accountId: string, listId: string): Promise<void> {
			await call(`/accounts/${accountId}/rules/lists/${listId}`, { method: 'DELETE' });
		},

		/** All items in the list — cursors through pages. */
		async listItems(accountId: string, listId: string): Promise<CfListItem[]> {
			const items: CfListItem[] = [];
			let cursor: string | undefined;
			for (;;) {
				const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
				const res = await doFetch(
					`${base}/accounts/${accountId}/rules/lists/${listId}/items${qs}`,
					{
						headers: {
							authorization: `Bearer ${opts.token}`,
							'content-type': 'application/json'
						}
					}
				);
				const body = (await res.json()) as CfEnvelope<CfListItem[]>;
				if (!body.success) {
					const first = body.errors?.[0];
					throw new CfError(first?.message ?? `list items failed (${res.status})`, {
						status: res.status,
						code: first?.code ?? null,
						retryAfterMs: retryAfterMs(res)
					});
				}
				items.push(...body.result);
				cursor = body.result_info?.cursor || undefined;
				if (!cursor || body.result.length === 0) break;
			}
			return items;
		},

		/** One bulk diff call — CF serializes it server-side into an async operation. */
		async bulkUpdate(
			accountId: string,
			listId: string,
			diff: { add: CfListItem[]; remove: { ip: string }[] }
		): Promise<{ operationId: string }> {
			const r = await call<{ operation_id: string }>(
				`/accounts/${accountId}/rules/lists/${listId}/items`,
				{ method: 'PUT', body: JSON.stringify(diff) }
			);
			return { operationId: r.operation_id };
		},

		async bulkOperation(
			accountId: string,
			listId: string,
			operationId: string
		): Promise<BulkOperation> {
			const r = await call<{ id: string; status: string; error?: string; completed?: string }>(
				`/accounts/${accountId}/rules/lists/${listId}/bulk_operations/${operationId}`
			);
			const status: BulkOperationStatus =
				r.status === 'completed' ? 'completed' : r.status === 'failed' ? 'failed' : 'pending';
			return { id: r.id, status, error: r.error, completed: r.completed };
		},

		/** The zone's custom-rules entrypoint — may 404 when no rules exist yet. */
		async getCustomRules(zoneId: string): Promise<CfRuleset | null> {
			try {
				return await call<CfRuleset>(
					`/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`
				);
			} catch (e) {
				if (e instanceof CfError && (e.status === 404 || e.code === 10002)) return null;
				throw e;
			}
		},

		/** Replaces the zone's custom ruleset — callers merge, not append blindly. */
		async putCustomRules(zoneId: string, rules: CfRule[]): Promise<CfRuleset> {
			return call<CfRuleset>(
				`/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`,
				{ method: 'PUT', body: JSON.stringify({ rules }) }
			);
		}
	};
}

function retryAfterMs(res: Response): number | null {
	const h = res.headers.get('retry-after');
	if (!h) return null;
	const secs = Number(h);
	return Number.isFinite(secs) ? secs * 1000 : null;
}

export const CF_LIST_NAME_PREFIX = 'crowdsec_dash_';

/** Sanitize a server label into the allowed list-name charset (a-z0-9_, ≤50 chars). */
export function listNameFor(label: string): string {
	const clean = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	const budget = 50 - CF_LIST_NAME_PREFIX.length;
	return CF_LIST_NAME_PREFIX + (clean.slice(0, budget) || 'server');
}
