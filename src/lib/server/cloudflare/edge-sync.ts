/**
 * Edge list synchronization — gathers active local-origin decisions,
 * diffs them against the live Cloudflare list, applies one serialized
 * bulk update, polls the async operation, and records the outcome on
 * the account row. Cloudflare list items never expire on their own, so
 * removals (expired/deleted decisions) are computed here too — when the
 * dashboard is down the list goes stale rather than empty.
 */

import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { cloudflareAccount, decision } from '#lib/server/db/app.schema.ts';
import { cfClient, CfError, type CfClientOptions } from './client.ts';
import { applyCapacity, diffItems, edgeCandidates } from './sync.ts';
import { accountToken, ensureList, makeClient, setClientFactoryForTests } from './accounts.ts';

/** Cloudflare Free plan: 10,000 items across all custom lists. */
const FREE_TOTAL_CAPACITY = 10_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_ATTEMPTS = 20;
const RETRY_ATTEMPTS = 3;

let clientFactory: (opts: CfClientOptions) => ReturnType<typeof cfClient> = makeClient;
export function setEdgeClientFactory(fn: typeof clientFactory | null) {
	clientFactory = fn ?? makeClient;
	setClientFactoryForTests(fn);
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

/** One CF call with bounded 429 backoff (Retry-After honored). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
	let attempt = 0;
	for (;;) {
		try {
			return await fn();
		} catch (e) {
			if (e instanceof CfError && e.status === 429 && ++attempt <= RETRY_ATTEMPTS) {
				await sleep(e.retryAfterMs ?? 1000 * attempt);
				continue;
			}
			throw e;
		}
	}
}

async function recordSync(
	accountId: string,
	state: 'ok' | 'degraded' | 'failed',
	fields: Partial<typeof cloudflareAccount.$inferInsert> = {}
) {
	await db
		.update(cloudflareAccount)
		.set({ lastSyncAt: new Date(), lastSyncState: state, ...fields })
		.where(eq(cloudflareAccount.id, accountId));
}

export interface EdgeSyncResult {
	items: number;
	added: number;
	removed: number;
	dropped: number;
	skipped?: string;
}

/**
 * Reconcile the account's list to the projected decision table. The
 * dashboard's local `decision` projection is the source (it already
 * carries origin/expiry), so no extra LAPI bouncer key is needed.
 */
export async function syncEdgeList(accountId: string): Promise<EdgeSyncResult> {
	const account = await db.query.cloudflareAccount.findFirst({
		where: eq(cloudflareAccount.id, accountId)
	});
	if (!account) throw new Error(`cloudflare account ${accountId} not found`);
	if (!account.cfAccountId) {
		await recordSync(accountId, 'degraded', { lastSyncError: 'no account discovered yet' });
		return { items: 0, added: 0, removed: 0, dropped: 0, skipped: 'no account id' };
	}

	const list = await ensureList(accountId);
	const cf = clientFactory({ token: await accountToken(account) });

	try {
		// Capacity = Free-plan total minus items in other lists (we can't
		// control those, so we only trim ours honestly).
		const lists = await withRetry(() => cf.listLists(account!.cfAccountId));
		const others = lists
			.filter((l) => l.id !== list.id)
			.reduce((sum, l) => sum + (l.num_items ?? 0), 0);
		const capacity = Math.max(0, FREE_TOTAL_CAPACITY - others);

		const decisions = await db
			.select({
				value: decision.value,
				origin: decision.origin,
				scope: decision.scope,
				type: decision.type,
				scenario: decision.scenario,
				until: decision.until,
				expired: decision.expired
			})
			.from(decision);
		const candidates = edgeCandidates(decisions);
		const { kept, dropped } = applyCapacity(candidates, capacity);

		const current = await withRetry(() => cf.listItems(account!.cfAccountId, list.id));
		const diff = diffItems(current, kept);
		if (diff.add.length === 0 && diff.remove.length === 0) {
			await recordSync(accountId, dropped > 0 ? 'degraded' : 'ok', {
				listItemCount: current.length,
				listDropped: dropped,
				lastSyncError: dropped ? `${dropped} decisions over list capacity` : null
			});
			return { items: current.length, added: 0, removed: 0, dropped };
		}

		const { operationId } = await withRetry(() =>
			cf.bulkUpdate(account!.cfAccountId, list.id, diff)
		);
		let status = 'pending';
		for (let i = 0; i < POLL_ATTEMPTS && status === 'pending'; i++) {
			await sleep(POLL_INTERVAL_MS);
			const op = await withRetry(() =>
				cf.bulkOperation(account!.cfAccountId, list.id, operationId)
			);
			status = op.status;
			if (op.status === 'failed')
				throw new Error(`bulk operation failed: ${op.error ?? 'unknown'}`);
		}
		if (status !== 'completed') throw new Error('bulk operation did not complete in time');

		const items = kept.length;
		await recordSync(accountId, dropped > 0 ? 'degraded' : 'ok', {
			listItemCount: items,
			listDropped: dropped,
			lastSyncError: dropped ? `${dropped} decisions over list capacity` : null
		});
		return { items, added: diff.add.length, removed: diff.remove.length, dropped };
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		await recordSync(accountId, 'failed', { lastSyncError: message });
		throw e;
	}
}
