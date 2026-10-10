import { beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.ts';
import {
	activityRollup,
	alert,
	alertSite,
	decision,
	site,
	syncState
} from '#lib/server/db/app.schema.ts';
import type { LapiAlert } from '#lib/server/crowdsec/types.ts';
import {
	durationSince,
	isCentralOnly,
	reconcileActiveDecisions,
	syncAlerts
} from '#lib/server/crowdsec/sync.ts';
import { filterAlerts } from '../e2e/lapi-contract.mjs';
import type { AlertsQuery, LapiClient } from '#lib/server/crowdsec/client.ts';

function makeDb() {
	const client = createClient({ url: ':memory:' });
	return drizzle(client, { schema });
}
type TestDb = ReturnType<typeof makeDb>;

async function addSite(db: TestDb, hostname: string, aliases: string[] = []) {
	const id = crypto.randomUUID();
	await db
		.insert(site)
		.values({ id, hostname, source: 'manual', aliases: JSON.stringify(aliases) });
	return id;
}

const future = (h = 4) => new Date(Date.now() + h * 3_600_000).toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const baseAlert = (over: Partial<LapiAlert>): LapiAlert => ({
	id: 1,
	scenario: 'crowdsecurity/http-probing',
	message: 'test',
	started_at: ago(1),
	created_at: ago(1),
	source: {
		scope: 'Ip',
		value: '203.0.113.7',
		ip: '203.0.113.7',
		cn: 'US',
		as_name: 'Contoso Cloud',
		latitude: 48.86,
		longitude: 2.35
	},
	decisions: [
		{
			id: 21,
			origin: 'crowdsec',
			type: 'ban',
			scope: 'Ip',
			value: '203.0.113.7',
			duration: '4h',
			scenario: 'crowdsecurity/http-probing',
			until: future(4),
			simulated: false
		}
	],
	context: [{ key: 'target_fqdn', value: 'blog.example.com' }],
	events: [{ meta: [{ key: 'service', value: 'http' }] }],
	...over
});

/**
 * Fake LAPI backed by the shared contract module — the same semantics the
 * e2e mock enforces: duration windows, include_capi, ordering, limits.
 * `queries` records every AlertsQuery for assertions.
 */
function lapiFake(alerts: LapiAlert[], queries: AlertsQuery[] = []): LapiClient {
	return {
		alerts: async (q: AlertsQuery = {}) => {
			queries.push(q);
			const params = new URLSearchParams();
			if (q.since) params.set('since', q.since);
			if (q.until) params.set('until', q.until);
			if (q.createdBefore) params.set('created_before', q.createdBefore);
			if (q.limit) params.set('limit', String(q.limit));
			if (q.includeCapi === false) params.set('include_capi', 'false');
			if (q.hasActiveDecision) params.set('has_active_decision', 'true');
			if (q.sort) params.set('sort', q.sort);
			if (q.origin) params.set('origin', q.origin);
			if (q.scenario) params.set('scenario', q.scenario);
			if (q.ip) params.set('ip', q.ip);
			if (q.includeSimulation !== undefined) params.set('simulated', String(q.includeSimulation));
			const r = filterAlerts(alerts, params);
			if (r.error) throw new Error(r.error.message);
			return r.alerts as LapiAlert[];
		}
	} as unknown as LapiClient;
}

describe('isCentralOnly', () => {
	it('flags CAPI/lists origins', () => {
		const a = baseAlert({ decisions: [{ id: 1, origin: 'CAPI', type: 'ban' }] });
		expect(isCentralOnly(a)).toBe(true);
		expect(isCentralOnly(baseAlert({}))).toBe(false); // origin crowdsec
	});
});

describe('durationSince', () => {
	it('produces clamped Go duration strings', () => {
		const now = Date.parse('2026-01-01T12:00:00Z');
		expect(durationSince(new Date('2026-01-01T08:00:00Z'), now)).toBe('14400s');
		expect(durationSince(new Date('2026-01-01T08:00:00Z'), now, 3600)).toBe('18000s');
		expect(durationSince(new Date('2026-01-01T13:00:00Z'), now)).toBe('0s');
		expect(durationSince(new Date('2026-01-01T11:00:00Z'), now, -3600)).toBe('0s');
	});
});

describe('syncAlerts', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	it('imports fixture alerts and skips anything central-only', async () => {
		await addSite(db, 'blog.example.com');
		const client = lapiFake([baseAlert({})]);
		const res = await syncAlerts(db, client);
		expect(res.fetched).toBe(1);
		expect(res.stored).toBe(1);
		expect(res.skippedCentral).toBe(0);
		expect(res.partial).toBe(false);

		const rows = await db.select().from(alert);
		expect(rows).toHaveLength(1);
		expect(rows[0].sourceAsName).toBe('Contoso Cloud');
		expect(rows[0].sourceLatitude).toBeCloseTo(48.86, 2);

		const links = await db.select().from(alertSite);
		expect(links).toHaveLength(1);
		expect(links[0].signal).toBe('context');

		const decs = await db.select().from(decision);
		expect(decs).toHaveLength(1);
		expect(decs[0].expired).toBe(false);
		expect(decs[0].scope).toBe('Ip');

		const roll = await db.select().from(activityRollup);
		expect(roll).toHaveLength(1);
		expect(roll[0].count).toBe(1);

		const state = await db.select().from(syncState).where(eq(syncState.source, 'alerts'));
		expect(state[0].lastSuccessAt).toBeTruthy();
		expect(state[0].partial).toBe(false);
	});

	it('sends include_capi=false so central alerts never arrive', async () => {
		const queries: AlertsQuery[] = [];
		const client = lapiFake(
			[
				baseAlert({}),
				baseAlert({
					id: 2,
					created_at: ago(2),
					started_at: ago(2),
					source: { scope: 'Ip', value: '192.0.2.1', ip: '192.0.2.1' },
					decisions: [{ id: 22, origin: 'CAPI', type: 'ban', value: '192.0.2.1' }]
				})
			],
			queries
		);
		const res = await syncAlerts(db, client);
		expect(queries.every((q) => q.includeCapi === false)).toBe(true);
		expect(res.fetched).toBe(1); // the CAPI alert was filtered upstream
		expect((await db.select().from(alert)).length).toBe(1);
	});

	it('still skips central-only alerts a lax upstream might return', async () => {
		const client = {
			alerts: async () => [baseAlert({ decisions: [{ id: 9, origin: 'lists', type: 'ban' }] })]
		} as unknown as LapiClient;
		const res = await syncAlerts(db, client);
		expect(res.skippedCentral).toBe(1);
		expect(res.stored).toBe(0);
	});

	it('sends the cursor as a duration since, not a timestamp', async () => {
		const client = lapiFake([baseAlert({})]);
		await syncAlerts(db, client);

		const queries: AlertsQuery[] = [];
		await syncAlerts(db, lapiFake([], queries));
		expect(queries.length).toBeGreaterThan(0);
		for (const q of queries) expect(q.since).toMatch(/^\d+s$/);
	});

	it('pages backward through created_before without losing alerts', async () => {
		const batch = Array.from({ length: 5 }, (_, i) =>
			baseAlert({ id: i + 1, created_at: ago(i + 1), started_at: ago(i + 1) })
		);
		const queries: AlertsQuery[] = [];
		const res = await syncAlerts(db, lapiFake(batch, queries), { pageSize: 2, maxPages: 10 });
		// Page boundaries overlap by 5 s, so the same ids can be re-fetched —
		// stored counts upserts; the projection dedupes by upstream id.
		expect(res.stored).toBeGreaterThanOrEqual(5);
		expect(res.partial).toBe(false);
		// Later pages constrain by created_before (a duration), not by id.
		expect(queries.length).toBeGreaterThan(1);
		expect(queries.slice(1).every((q) => /^\d+s$/.test(q.createdBefore ?? ''))).toBe(true);
		expect((await db.select().from(alert)).length).toBe(5);
	});

	it('does not re-process alerts already known and older than the cursor', async () => {
		const stale = baseAlert({ id: 1, created_at: ago(30), started_at: ago(30) });
		await syncAlerts(db, lapiFake([stale]));

		const fresh = baseAlert({ id: 2, created_at: ago(0.1), started_at: ago(0.1) });
		const res = await syncAlerts(db, lapiFake([fresh, stale]));
		// The stale alert was re-fetched (overlap window) but skipped: stored
		// counts only the new one.
		expect(res.stored).toBe(1);
		expect((await db.select().from(alert)).length).toBe(2);
	});

	it('leaves a backfill cursor when the initial import hits maxPages', async () => {
		const many = Array.from({ length: 5 }, (_, i) =>
			baseAlert({ id: i + 1, created_at: ago(i + 1), started_at: ago(i + 1) })
		);
		const res = await syncAlerts(db, lapiFake(many), { pageSize: 2, maxPages: 1 });
		expect(res.partial).toBe(true);
		const [bf] = await db.select().from(syncState).where(eq(syncState.source, 'alerts.backfill'));
		expect(bf.cursor).toBeTruthy();
		expect(
			(await db.select().from(syncState).where(eq(syncState.source, 'alerts')))[0].partial
		).toBe(true);

		// Later calls drain the backfill — up to 5 pages per tick — and clear
		// the partial flag once the window is exhausted.
		await syncAlerts(db, lapiFake(many), { pageSize: 2, maxPages: 1 });
		const done = await db.select().from(syncState).where(eq(syncState.source, 'alerts.backfill'));
		expect(done).toHaveLength(0);
		expect(
			(await db.select().from(syncState).where(eq(syncState.source, 'alerts')))[0].partial
		).toBe(false);
		expect((await db.select().from(alert)).length).toBe(5);
	});

	it('creates a backfill row when an incremental pass hits maxPages', async () => {
		// First import completes: 3 alerts, cursor at their newest.
		const initial = Array.from({ length: 3 }, (_, i) =>
			baseAlert({ id: i + 1, created_at: ago(10 + i), started_at: ago(10 + i) })
		);
		await syncAlerts(db, lapiFake(initial));

		// A burst of newer alerts arrives (e.g. after a dashboard outage) —
		// a capped incremental pass cannot reach the old cursor in one tick.
		const burst = Array.from({ length: 8 }, (_, i) =>
			baseAlert({ id: 10 + i, created_at: ago(0.5 + i * 0.5), started_at: ago(0.5 + i * 0.5) })
		);
		const all = [...burst, ...initial];
		const res = await syncAlerts(db, lapiFake(all), { pageSize: 2, maxPages: 1 });
		expect(res.partial).toBe(true);
		const [bf] = await db.select().from(syncState).where(eq(syncState.source, 'alerts.backfill'));
		expect(bf.cursor).toBeTruthy();

		// Later ticks fill the gap between the old cursor and `reached`
		// without loss; the row is removed once the window is covered.
		await syncAlerts(db, lapiFake(all), { pageSize: 2, maxPages: 10 });
		// The continuation caps at 5 pages per tick — a second tick drains it.
		await syncAlerts(db, lapiFake(all), { pageSize: 2, maxPages: 10 });
		expect(
			await db.select().from(syncState).where(eq(syncState.source, 'alerts.backfill'))
		).toHaveLength(0);
		expect((await db.select().from(alert)).length).toBe(11);
		expect(
			(await db.select().from(syncState).where(eq(syncState.source, 'alerts')))[0].partial
		).toBe(false);
	});

	it('normalizes mixed-format created_at before comparing', async () => {
		// LAPI timestamps arrive in mixed formats — "…05Z" sorts after
		// "…05.000Z" as a raw string but is the same instant. Comparisons
		// must run on normalized ISO strings so same-instant boundaries
		// don't confuse the same-second guard or the cursor check.
		const base = Date.now() - 3600_000;
		const t = (ms: number, plain = false) =>
			plain
				? new Date(base + ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
				: new Date(base + ms).toISOString();
		const many = [
			baseAlert({ id: 1, created_at: t(0), started_at: t(0) }),
			baseAlert({ id: 2, created_at: t(0, true), started_at: t(0, true) }), // "…05Z"
			baseAlert({ id: 3, created_at: t(0, true), started_at: t(0, true) }), // "…05Z"
			baseAlert({ id: 4, created_at: t(-90_000), started_at: t(-90_000) })
		];
		// The whole pile fits one page — the same-second replay stays a
		// single overlap page instead of starving the older alert.
		await syncAlerts(db, lapiFake(many), { pageSize: 4, maxPages: 10 });
		expect((await db.select().from(alert)).length).toBe(4);

		// Steady state: the no-op incremental pass stores nothing and no
		// backfill row is left dangling once the same-second replay drains.
		const res2 = await syncAlerts(db, lapiFake(many), { pageSize: 4, maxPages: 10 });
		expect(res2.stored).toBe(0);
		expect(res2.partial).toBe(false);
		expect(
			await db.select().from(syncState).where(eq(syncState.source, 'alerts.backfill'))
		).toHaveLength(0);
		expect((await db.select().from(alert)).length).toBe(4);
	});

	it('never stores simulated alerts (queries send simulated=false)', async () => {
		const sim = baseAlert({ id: 7, simulated: true });
		const real = baseAlert({ id: 8 });
		const queries: AlertsQuery[] = [];
		const res = await syncAlerts(db, lapiFake([sim, real], queries));
		expect(queries.length).toBeGreaterThan(0);
		expect(queries.every((q) => q.includeSimulation === false)).toBe(true);
		expect(res.stored).toBe(1);
		const rows = await db.select().from(alert);
		expect(rows).toHaveLength(1);
		expect(rows[0].upstreamId).toBe(8);
	});

	it('attributes via aliases as well as the primary hostname', async () => {
		const siteId = await addSite(db, 'blog.example.com', ['admin.blog.example.com']);
		const a = baseAlert({
			id: 9,
			context: [{ key: 'target_fqdn', value: 'admin.blog.example.com' }]
		});
		await syncAlerts(db, lapiFake([a]));
		const links = await db.select().from(alertSite);
		expect(links.map((l) => l.siteId)).toEqual([siteId]);
	});

	it('re-sync keeps rollups consistent (no double counting)', async () => {
		const client = lapiFake([baseAlert({})]);
		await syncAlerts(db, client);
		await syncAlerts(db, lapiFake([baseAlert({})]));
		const roll = await db.select().from(activityRollup);
		expect(roll[0].count).toBe(1); // not 2 — known-and-old alerts are skipped
	});
});

describe('reconcileActiveDecisions', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	it('expires local decisions missing from the upstream active set', async () => {
		// Upstream has one active decision (id 21); local projection also has
		// an active decision (id 999) whose alert left the sync window.
		const client = lapiFake([baseAlert({})]);
		await db.insert(decision).values({
			id: 'd-stale',
			upstreamId: 999,
			type: 'ban',
			scope: 'Ip',
			value: '198.51.100.99',
			expired: false,
			syncedAt: new Date()
		});
		const res = await reconcileActiveDecisions(db, client);
		expect(res.partial).toBe(false);
		expect(res.expired).toBe(1);
		const [stale] = await db.select().from(decision).where(eq(decision.upstreamId, 999));
		expect(stale.expired).toBe(true);
		// The still-active upstream decision was upserted and stays live.
		const [live] = await db.select().from(decision).where(eq(decision.upstreamId, 21));
		expect(live.expired).toBe(false);
	});

	it(
		'refuses to mark-missing when the upstream result hit the limit',
		{ timeout: 60_000 },
		async () => {
			const many = Array.from({ length: 5000 }, (_, i) =>
				baseAlert({
					id: i + 1,
					created_at: ago(1),
					decisions: [
						{
							id: 10_000 + i,
							origin: 'crowdsec',
							type: 'ban',
							value: `10.0.${i % 255}.${i}`,
							until: future()
						}
					]
				})
			);
			const client = lapiFake(many);
			await db.insert(decision).values({
				id: 'd-local',
				upstreamId: 55_555,
				type: 'ban',
				scope: 'Ip',
				value: '203.0.113.55',
				expired: false,
				syncedAt: new Date()
			});
			const res = await reconcileActiveDecisions(db, client);
			expect(res.partial).toBe(true);
			expect(res.expired).toBe(0);
			const [row] = await db.select().from(decision).where(eq(decision.upstreamId, 55_555));
			expect(row.expired).toBe(false); // provably incomplete set — nothing marked
		}
	);
});
