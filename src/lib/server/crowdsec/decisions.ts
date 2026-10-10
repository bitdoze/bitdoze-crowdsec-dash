/**
 * Manual decision lifecycle: request → pushed → confirmed → removing →
 * removed. The dashboard pushes via `POST /v1/alerts` (tier A write); the
 * worker reconciles `pushed` rows against the synced `decision`
 * projection so the UI can distinguish "requested" from
 * "upstream-confirmed".
 */
import { and, eq, sql } from 'drizzle-orm';
import { decision, decisionRequest } from '#lib/server/db/app.schema.ts';
import { LapiClient } from './client.ts';
import type { db } from '#lib/server/db/index.ts';
import { markEdgeDirty } from '#lib/server/cloudflare/edge-dirty.ts';

type Db = typeof db;

const id = () => crypto.randomUUID();

/** Push a manual ban/captcha through the LAPI and record it locally. */
export async function requestDecision(
	database: Db,
	client: LapiClient,
	input: {
		scope: 'ip' | 'range';
		value: string;
		type: 'ban' | 'captcha';
		durationS: number;
		reason?: string;
		userId?: string;
	}
): Promise<{ ok: boolean; error?: string }> {
	const row = {
		id: id(),
		scope: input.scope,
		value: input.value,
		type: input.type,
		durationS: input.durationS,
		reason: input.reason ?? null,
		state: 'pushed' as const,
		createdBy: input.userId ?? null,
		updatedAt: new Date()
	};
	try {
		const res = await client.pushManualDecision({
			scope: input.scope,
			value: input.value,
			type: input.type,
			// LAPI takes a duration string like "4h" / "4h30m"
			duration: formatDuration(input.durationS),
			reason: input.reason
		});
		// LAPI silently skips allowlisted sources — the ids array comes
		// back empty, which is a failure the UI must show honestly.
		if (Array.isArray(res) && res.length === 0) {
			const error = 'LAPI stored no alert — the address is probably on a centralized allowlist.';
			await database.insert(decisionRequest).values({ ...row, state: 'failed', error });
			return { ok: false, error };
		}
	} catch (e) {
		await database.insert(decisionRequest).values({ ...row, state: 'failed', error: msg(e) });
		return { ok: false, error: msg(e) };
	}
	await database.insert(decisionRequest).values(row);
	markEdgeDirty();
	await reconcile(database);
	return { ok: true };
}

/**
 * Request removal of an upstream decision. `upstreamId` is the LAPI
 * decision id from the projection. Records a `removing` row so the UI
 * shows the request until the projection confirms it's gone.
 */
export async function requestRemoval(
	database: Db,
	client: LapiClient,
	upstreamDecisionId: number,
	value: string,
	userId?: string
): Promise<{ ok: boolean; error?: string }> {
	try {
		await client.deleteDecision(upstreamDecisionId);
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
	// The LAPI expires the decision immediately — mirror that in the
	// projection now instead of waiting for the alert to re-sync (it may
	// be outside the sync window entirely).
	await database
		.update(decision)
		.set({ expired: true, until: new Date() })
		.where(eq(decision.upstreamId, upstreamDecisionId));
	await database.insert(decisionRequest).values({
		id: id(),
		scope: value.includes('/') ? 'range' : 'ip',
		value,
		type: 'ban',
		durationS: 0,
		reason: `unban ${value}`,
		state: 'removing',
		upstreamId: upstreamDecisionId,
		createdBy: userId ?? null,
		updatedAt: new Date()
	});
	markEdgeDirty();
	await reconcile(database);
	return { ok: true };
}

/**
 * Reconcile pending requests against the decision projection:
 * - `pushed` → `confirmed` when an active decision covers the value.
 * - `removing` → `removed` when no active decision for the value remains.
 */
export async function reconcile(database: Db): Promise<{ confirmed: number; removed: number }> {
	const pending = await database
		.select()
		.from(decisionRequest)
		.where(sql`${decisionRequest.state} IN ('pushed', 'removing')`);
	let confirmed = 0;
	let removed = 0;
	for (const req of pending) {
		// A removal carrying its upstream id resolves against that exact
		// row — absent or expired counts as gone, regardless of whether
		// the decision ever entered the sync window.
		if (req.state === 'removing' && req.upstreamId != null) {
			const [row] = await database
				.select({ expired: decision.expired })
				.from(decision)
				.where(eq(decision.upstreamId, req.upstreamId))
				.limit(1);
			if (!row || row.expired) {
				await database
					.update(decisionRequest)
					.set({ state: 'removed', updatedAt: new Date() })
					.where(eq(decisionRequest.id, req.id));
				removed++;
			}
			continue;
		}
		const [active] = await database
			.select({ id: decision.upstreamId })
			.from(decision)
			.where(and(eq(decision.value, req.value), eq(decision.expired, false)))
			.limit(1);
		if (req.state === 'pushed' && active) {
			await database
				.update(decisionRequest)
				.set({ state: 'confirmed', upstreamId: active.id, updatedAt: new Date() })
				.where(eq(decisionRequest.id, req.id));
			confirmed++;
		} else if (req.state === 'removing' && !active) {
			await database
				.update(decisionRequest)
				.set({ state: 'removed', updatedAt: new Date() })
				.where(eq(decisionRequest.id, req.id));
			removed++;
		}
	}
	return { confirmed, removed };
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Seconds → LAPI duration string ("4h", "4h30m", "2d"). */
export function formatDuration(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join('') || '0s';
}
