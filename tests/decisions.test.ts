import { beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.ts';
import { decision, decisionRequest } from '#lib/server/db/app.schema.ts';
import {
	formatDuration,
	reconcile,
	requestDecision,
	requestRemoval
} from '#lib/server/crowdsec/decisions.ts';
import type { LapiClient } from '#lib/server/crowdsec/client.ts';

function makeDb() {
	return drizzle(createClient({ url: ':memory:' }), { schema });
}
type TestDb = ReturnType<typeof makeDb>;

const okClient = () =>
	({
		pushManualDecision: async () => ({}),
		deleteDecision: async () => ({})
	}) as unknown as LapiClient;

const failClient = (message: string) =>
	({
		pushManualDecision: async () => {
			throw new Error(message);
		},
		deleteDecision: async () => {
			throw new Error(message);
		}
	}) as unknown as LapiClient;

async function addDecisionRow(db: TestDb, upstreamId: number, value: string, expired = false) {
	await db.insert(decision).values({
		id: crypto.randomUUID(),
		upstreamId,
		type: 'ban',
		scope: 'Ip',
		value,
		expired,
		syncedAt: new Date()
	});
}

describe('decision requests', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	it('pushes a ban upstream and records a pushed request', async () => {
		const res = await requestDecision(db, okClient(), {
			scope: 'ip',
			value: '9.9.9.9',
			type: 'ban',
			durationS: 14400,
			reason: 'test'
		});
		expect(res.ok).toBe(true);
		const rows = await db.select().from(decisionRequest);
		expect(rows).toHaveLength(1);
		expect(rows[0].state).toBe('pushed');
		expect(rows[0].durationS).toBe(14400);
	});

	it('records failed requests with the upstream error', async () => {
		const res = await requestDecision(db, failClient('boom'), {
			scope: 'ip',
			value: '9.9.9.9',
			type: 'ban',
			durationS: 60
		});
		expect(res).toEqual({ ok: false, error: 'boom' });
		const rows = await db.select().from(decisionRequest);
		expect(rows[0].state).toBe('failed');
		expect(rows[0].error).toBe('boom');
	});

	it('confirms a pushed request when the projection shows the decision', async () => {
		await requestDecision(db, okClient(), {
			scope: 'ip',
			value: '9.9.9.9',
			type: 'ban',
			durationS: 60
		});
		await addDecisionRow(db, 555, '9.9.9.9');
		const { confirmed } = await reconcile(db);
		expect(confirmed).toBe(1);
		const row = (await db.select().from(decisionRequest))[0];
		expect(row.state).toBe('confirmed');
		expect(row.upstreamId).toBe(555);
	});

	it('does not confirm on an expired decision', async () => {
		await requestDecision(db, okClient(), {
			scope: 'ip',
			value: '9.9.9.9',
			type: 'ban',
			durationS: 60
		});
		await addDecisionRow(db, 555, '9.9.9.9', true);
		await reconcile(db);
		expect((await db.select().from(decisionRequest))[0].state).toBe('pushed');
	});

	it('marks removals as removed once the projection no longer has it', async () => {
		await addDecisionRow(db, 777, '8.8.8.8');
		const res = await requestRemoval(db, okClient(), 777, '8.8.8.8');
		expect(res.ok).toBe(true);
		// The LAPI expires the decision on delete — the projection mirrors
		// that immediately, so the request resolves in the same pass.
		const [proj] = await db.select().from(decision).where(eq(decision.upstreamId, 777));
		expect(proj.expired).toBe(true);
		expect(proj.until!.getTime()).toBeLessThanOrEqual(Date.now());
		expect((await db.select().from(decisionRequest))[0].state).toBe('removed');
	});

	it('resolves removals even for decisions that never entered the sync window', async () => {
		// No projection row at all — the upstream delete still resolved the
		// request: absent counts as gone for upstreamId-keyed removals.
		const res = await requestRemoval(db, okClient(), 888, '8.8.4.4');
		expect(res.ok).toBe(true);
		expect((await db.select().from(decisionRequest))[0].state).toBe('removed');
	});

	it('marks an empty-id response (all sources allowlisted) as failed', async () => {
		const client = {
			pushManualDecision: async () => [],
			deleteDecision: async () => ({})
		} as unknown as LapiClient;
		const res = await requestDecision(db, client, {
			scope: 'ip',
			value: '198.51.100.23',
			type: 'ban',
			durationS: 60
		});
		expect(res.ok).toBe(false);
		expect(res.error).toContain('allowlist');
		const rows = await db.select().from(decisionRequest);
		expect(rows[0].state).toBe('failed');
		expect(rows[0].error).toContain('allowlist');
	});

	it('keeps the request on removal failure', async () => {
		const res = await requestRemoval(db, failClient('denied'), 777, '8.8.8.8');
		expect(res).toEqual({ ok: false, error: 'denied' });
		expect(await db.select().from(decisionRequest)).toHaveLength(0);
	});
});

describe('formatDuration', () => {
	it('formats seconds into LAPI duration strings', () => {
		expect(formatDuration(14400)).toBe('4h');
		expect(formatDuration(16200)).toBe('4h30m');
		expect(formatDuration(172800)).toBe('2d');
		expect(formatDuration(5400)).toBe('1h30m');
		expect(formatDuration(45)).toBe('45s');
	});
});
