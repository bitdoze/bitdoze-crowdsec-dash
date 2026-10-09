import { beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'node:path';
import * as schema from '#lib/server/db/schema.ts';
import { alert, alertSite, decision, site, syncState } from '#lib/server/db/app.schema.ts';
import { syncAlerts } from '#lib/server/crowdsec/sync.ts';
import type { LapiAlert } from '#lib/server/crowdsec/types.ts';
import type { LapiClient } from '#lib/server/crowdsec/client.ts';

function makeDb() {
	const client = createClient({ url: ':memory:' });
	return drizzle(client, { schema });
}
type TestDb = ReturnType<typeof makeDb>;

async function migrateDb(db: TestDb) {
	await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
}

function alertFixture(over: Partial<LapiAlert> = {}): LapiAlert {
	return {
		id: 100,
		scenario: 'crowdsecurity/http-probing',
		created_at: '2026-10-09T10:00:00Z',
		started_at: '2026-10-09T09:59:00Z',
		stopped_at: '2026-10-09T10:00:00Z',
		source: { scope: 'Ip', value: '9.9.9.9', ip: '9.9.9.9', cn: 'CN', as_name: 'Bad ASN' },
		decisions: [
			{
				id: 900,
				origin: 'crowdsec',
				type: 'ban',
				scope: 'Ip',
				value: '9.9.9.9',
				duration: '4h',
				scenario: 'crowdsecurity/http-probing',
				until: '2999-01-01T00:00:00Z'
			}
		],
		context: [{ key: 'target_fqdn', value: 'blog.example.com' }],
		events: [{ meta: [{ key: 'service', value: 'http' }] }],
		...over
	};
}

const fakeClient = (pages: LapiAlert[][]) => {
	let n = 0;
	return {
		alerts: async () => pages[Math.min(n++, pages.length - 1)] ?? []
	} as unknown as LapiClient;
};

describe('syncAlerts', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrateDb(db);
	});

	it('stores alerts, decisions, learned sites and rollups', async () => {
		const res = await syncAlerts(db, fakeClient([[alertFixture()]]));
		expect(res.stored).toBe(1);
		expect(await db.select().from(alert)).toHaveLength(1);
		expect(await db.select().from(decision)).toHaveLength(1);
		expect(await db.select().from(site)).toEqual([
			expect.objectContaining({ hostname: 'blog.example.com', source: 'learned' })
		]);
		const links = await db.select().from(alertSite);
		expect(links).toHaveLength(1);
		expect(links[0].signal).toBe('context');
	});

	it('excludes alerts whose decisions are all central (CAPI/lists)', async () => {
		const capiOnly = alertFixture({
			id: 200,
			decisions: [{ id: 901, origin: 'CAPI', type: 'ban', scope: 'Ip', value: '1.1.1.1' }]
		});
		const res = await syncAlerts(db, fakeClient([[alertFixture(), capiOnly]]));
		expect(res.stored).toBe(1);
		expect(res.skippedCentral).toBe(1);
		expect(await db.select().from(alert)).toHaveLength(1);
	});

	it('resumes from the stored cursor on the next pass', async () => {
		const client = fakeClient([[alertFixture()]]);
		await syncAlerts(db, client);
		const seen: string[] = [];
		const spy = {
			alerts: async (q: { since?: string }) => {
				seen.push(q.since ?? '');
				return [];
			}
		} as unknown as LapiClient;
		await syncAlerts(db, spy);
		expect(seen[0]).toBe('2026-10-09T10:00:00.000Z');
	});

	it('reconciles decision removals on re-sync', async () => {
		const withTwo = alertFixture({
			decisions: [
				{
					id: 900,
					origin: 'crowdsec',
					type: 'ban',
					scope: 'Ip',
					value: '9.9.9.9',
					until: '2999-01-01T00:00:00Z'
				},
				{
					id: 901,
					origin: 'crowdsec',
					type: 'ban',
					scope: 'Ip',
					value: '9.9.9.9',
					until: '2999-01-01T00:00:00Z'
				}
			]
		});
		const backToOne = alertFixture();
		await syncAlerts(db, fakeClient([[withTwo]]));
		expect(await db.select().from(decision)).toHaveLength(2);
		// The overlap window refetches the same alert — row count must stay put.
		await syncAlerts(db, fakeClient([[backToOne], []]));
		expect(await db.select().from(decision)).toHaveLength(1);
		expect(await db.select().from(alert)).toHaveLength(1);
	});

	it('marks expired decisions when until has passed', async () => {
		const expired = alertFixture({
			decisions: [
				{
					id: 900,
					origin: 'crowdsec',
					type: 'ban',
					scope: 'Ip',
					value: '9.9.9.9',
					until: '2000-01-01T00:00:00Z'
				}
			]
		});
		await syncAlerts(db, fakeClient([[expired]]));
		const rows = await db.select().from(decision);
		expect(rows[0].expired).toBe(true);
	});

	it('keeps unattributed alerts and leaves no alert_site row', async () => {
		const noSignal = alertFixture({ context: [], events: [] });
		await syncAlerts(db, fakeClient([[noSignal]]));
		expect(await db.select().from(alert)).toHaveLength(1);
		expect(await db.select().from(alertSite)).toHaveLength(0);
	});

	it('flags partial while the bounded import is still paging', async () => {
		const full = () => Array.from({ length: 5 }, (_, i) => alertFixture({ id: 300 + i }));
		const res = await syncAlerts(db, fakeClient([full(), full(), full()]), {
			pageSize: 5,
			maxPages: 2
		});
		expect(res.partial).toBe(true);
		const [state] = await db.select().from(syncState);
		expect(state.partial).toBe(true);
	});
});
