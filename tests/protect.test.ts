import { beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'node:path';
import * as schema from '#lib/server/db/schema.ts';
import {
	alert,
	alertSite,
	metricSample,
	protectionCheck,
	site,
	syncState
} from '#lib/server/db/app.schema.ts';
import { driftHash, generatePlan, TEST_SCENARIO } from '#lib/server/protect/templates.ts';
import { markTestWindow, runCheck, runSiteChecks } from '#lib/server/protect/checks.ts';
import { regeneratePlan, markArtifact, listArtifacts } from '#lib/server/protect/plan.ts';
import { eq } from 'drizzle-orm';

function makeDb() {
	const client = createClient({ url: ':memory:' });
	return drizzle(client, { schema });
}
type TestDb = ReturnType<typeof makeDb>;

async function migrateDb(db: TestDb) {
	await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
}

async function addSite(db: TestDb, over: Partial<typeof site.$inferInsert> = {}) {
	const id = crypto.randomUUID();
	await db.insert(site).values({
		id,
		hostname: 'blog.example.com',
		source: 'manual',
		proxy: 'caddy',
		runtime: 'docker',
		...over
	});
	return id;
}

const input = {
	hostname: 'blog.example.com',
	proxy: 'caddy' as const,
	runtime: 'docker' as const,
	cloudflare: false,
	lapiUrl: 'http://crowdsec:8080',
	logDir: '/var/log/proxy'
};

describe('generatePlan', () => {
	it('produces the full artifact set per proxy', () => {
		for (const proxy of ['caddy', 'traefik', 'nginx'] as const) {
			const arts = generatePlan({ ...input, proxy });
			const kinds = arts.map((a) => a.kind);
			expect(kinds).toContain('access_log');
			expect(kinds).toContain('acquisition');
			expect(kinds).toContain('real_ip');
			expect(kinds).toContain('bouncer');
			expect(kinds).toContain('appsec');
			expect(kinds).toContain('remediation');
			expect(kinds).toContain('compose'); // runtime=docker
		}
	});

	it('embeds the hostname and lapi URL in the generated config', () => {
		const arts = generatePlan(input);
		const caddyfile = arts.find((a) => a.kind === 'access_log')!;
		expect(caddyfile.content).toContain('blog.example.com');
		expect(caddyfile.content).toContain('/var/log/proxy/blog.example.com.log');
		const bouncer = arts.find((a) => a.kind === 'bouncer')!;
		expect(bouncer.content).toContain('http://crowdsec:8080');
	});

	it('emits a compose artifact only for docker runtimes', () => {
		const docker = generatePlan(input).map((a) => a.kind);
		const native = generatePlan({ ...input, runtime: 'native' }).map((a) => a.kind);
		expect(docker).toContain('compose');
		expect(native).not.toContain('compose');
	});

	it('adds Cloudflare ranges/headers when the site is behind Cloudflare', () => {
		const cf = generatePlan({ ...input, proxy: 'nginx', cloudflare: true });
		const realIp = cf.find((a) => a.kind === 'real_ip')!;
		expect(realIp.content).toContain('CF-Connecting-IP');
		expect(realIp.content).toContain('173.245.48.0/20');
		const noCf = generatePlan({ ...input, proxy: 'nginx', cloudflare: false });
		expect(noCf.find((a) => a.kind === 'real_ip')!.content).not.toContain('CF-Connecting-IP');
	});

	it('returns a guidance artifact for unknown proxies', () => {
		const arts = generatePlan({ ...input, proxy: 'unknown' });
		expect(arts[0].content).toContain('set the site');
	});

	it('composes appsec configs per WAF level and omits the artifact when off', () => {
		const appsecOf = (level: 'off' | '1' | '2' | '3' | '4') =>
			generatePlan({ ...input, proxy: 'nginx', wafLevel: level }).find((a) => a.kind === 'appsec');
		expect(appsecOf('1')!.content).toContain('crowdsecurity/virtual-patching');
		expect(appsecOf('1')!.content).not.toContain('appsec-generic-rules');
		expect(appsecOf('2')!.content).toContain('appsec-generic-rules');
		expect(appsecOf('3')!.content).toContain('crowdsecurity/appsec-crs');
		expect(appsecOf('3')!.content).not.toContain('appsec-crs-inband');
		expect(appsecOf('4')!.content).toContain('appsec-crs-inband');
		expect(appsecOf('off')).toBeUndefined();
		// Level 'off' keeps detection artifacts — AppSec toggles independently.
		const kinds = generatePlan({ ...input, proxy: 'nginx', wafLevel: 'off' }).map((a) => a.kind);
		expect(kinds).toContain('acquisition');
		expect(kinds).toContain('bouncer');
	});

	it('installs the level-matching collections and varies remediation presets', () => {
		const l3 = generatePlan({ ...input, wafLevel: '3' }).find((a) => a.kind === 'collections')!;
		expect(l3.content).toContain('appsec-generic-rules');
		expect(l3.content).toContain('appsec-crs');
		const flat = generatePlan({ ...input, remediationPreset: 'flat' }).find(
			(a) => a.kind === 'remediation'
		)!;
		expect(flat.content).not.toContain('duration_expr');
		const esc = generatePlan({ ...input, remediationPreset: 'escalating' }).find(
			(a) => a.kind === 'remediation'
		)!;
		expect(esc.content).toContain('GetDecisionsCount');
		const captcha = generatePlan({ ...input, remediationPreset: 'captcha' }).find(
			(a) => a.kind === 'remediation'
		)!;
		expect(captcha.content).toContain('type: captcha');
		expect(captcha.content).toContain('type: ban'); // fallback block stays
	});

	it('adds per-site AppSec exclusion collections to the install artifact', () => {
		const c = generatePlan({
			...input,
			wafLevel: '2',
			appsecExclusions: ['crowdsecurity/appsec-wordpress']
		}).find((a) => a.kind === 'collections')!;
		expect(c.content).toContain('cscli collections install crowdsecurity/appsec-wordpress');
		const none = generatePlan({ ...input, wafLevel: '2' }).find((a) => a.kind === 'collections')!;
		expect(none.content).not.toContain('wordpress');
	});

	it('driftHash treats a substituted bouncer key as in-sync', () => {
		const desired = 'API_URL=http://crowdsec:8080\nAPI_KEY=<bouncer-key>\nlisten: 1\n';
		const applied = 'API_URL=http://crowdsec:8080\nAPI_KEY=real-issued-key-xyz\nlisten: 1\n';
		expect(driftHash(desired)).toBe(driftHash(applied));
		expect(driftHash(applied)).not.toBe(driftHash(applied + '# edited\n'));
	});
});

describe('plan persistence', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrateDb(db);
	});

	it('persists artifacts and preserves applied state across regeneration', async () => {
		const siteId = await addSite(db);
		await regeneratePlan(db, siteId);
		const first = await listArtifacts(db, siteId);
		expect(first.length).toBeGreaterThan(4);
		const target = first.find((a) => a.kind === 'access_log')!;
		await markArtifact(db, target.id, 'applied');
		// Same answers → same hash → state preserved.
		await regeneratePlan(db, siteId);
		const after = await listArtifacts(db, siteId);
		expect(after.find((a) => a.kind === 'access_log')!.state).toBe('applied');
		// Changed topology → changed content → back to not_applied.
		await db.update(site).set({ proxy: 'nginx' }).where(eq(site.id, siteId));
		await regeneratePlan(db, siteId);
		const regen = await listArtifacts(db, siteId);
		expect(regen.find((a) => a.kind === 'access_log')!.state).toBe('not_applied');
		expect(regen.find((a) => a.kind === 'access_log')!.content).toContain('log_format crowdsec');
	});
});

describe('protection checks', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrateDb(db);
	});

	it('acquisition verifies when alerts are attributed', async () => {
		const siteId = await addSite(db);
		await db.insert(alert).values({
			id: 'a1',
			upstreamId: 42,
			scenario: 'crowdsecurity/http-probing',
			startedAt: new Date(),
			syncedAt: new Date()
		});
		await db.insert(alertSite).values({ alertUpstreamId: 42, siteId, signal: 'context' });
		const r = await runCheck(db, siteId, 'acquisition');
		expect(r.state).toBe('verified');
		expect(r.evidence.scenario).toBe('crowdsecurity/http-probing');
	});

	it('test_alert needs a window, then verifies on the generic-test alert', async () => {
		const siteId = await addSite(db);
		let r = await runCheck(db, siteId, 'test_alert');
		expect(r.state).toBe('not_run');
		await markTestWindow(db, siteId);
		const [row] = await db
			.select()
			.from(protectionCheck)
			.where(eq(protectionCheck.id, `${siteId}|test_alert`));
		expect(row.markedAt).toBeTruthy();
		// Nothing yet → failed with whitelist guidance.
		r = await runCheck(db, siteId, 'test_alert');
		expect(r.state).toBe('failed');
		expect(String(r.evidence.message)).toContain('whitelists');
		// Test alert lands attributed → verified.
		await db.insert(alert).values({
			id: 'a2',
			upstreamId: 77,
			scenario: TEST_SCENARIO,
			startedAt: new Date(),
			syncedAt: new Date()
		});
		await db.insert(alertSite).values({ alertUpstreamId: 77, siteId, signal: 'context' });
		r = await runCheck(db, siteId, 'test_alert');
		expect(r.state).toBe('verified');
	});

	it('test_alert reports unattributed test alerts as stale (needs target_fqdn)', async () => {
		const siteId = await addSite(db);
		await markTestWindow(db, siteId);
		await db.insert(alert).values({
			id: 'a3',
			upstreamId: 78,
			scenario: TEST_SCENARIO,
			startedAt: new Date(),
			syncedAt: new Date()
		});
		const r = await runCheck(db, siteId, 'test_alert');
		expect(r.state).toBe('stale');
		expect(String(r.evidence.message)).toContain('target_fqdn');
	});

	it('decision_feed fails without sync and verifies with a healthy one', async () => {
		const siteId = await addSite(db);
		let r = await runCheck(db, siteId, 'decision_feed');
		expect(r.state).toBe('failed');
		await db.insert(syncState).values({ source: 'alerts', lastSuccessAt: new Date() });
		r = await runCheck(db, siteId, 'decision_feed');
		expect(r.state).toBe('verified');
	});

	it('waf is not_run without AppSec metrics and verified with blocked traffic', async () => {
		const siteId = await addSite(db);
		let r = await runCheck(db, siteId, 'waf');
		expect(r.state).toBe('not_run');
		await db.insert(metricSample).values([
			{
				id: 'm1',
				at: new Date(),
				name: 'cs_appsec_processed_requests',
				labels: '{}',
				value: 10
			}
		]);
		r = await runCheck(db, siteId, 'waf');
		expect(r.state).toBe('stale'); // processed but never blocked
		await db.insert(metricSample).values({
			id: 'm2',
			at: new Date(),
			name: 'cs_appsec_blocked_requests',
			labels: '{}',
			value: 2
		});
		r = await runCheck(db, siteId, 'waf');
		expect(r.state).toBe('verified');
	});

	it('a verified check promotes applied artifacts to verified', async () => {
		const siteId = await addSite(db);
		await regeneratePlan(db, siteId);
		const [art] = await listArtifacts(db, siteId);
		await markArtifact(db, art.id, 'applied');
		await db.insert(alert).values({
			id: 'a4',
			upstreamId: 88,
			scenario: 'crowdsecurity/http-probing',
			startedAt: new Date(),
			syncedAt: new Date()
		});
		await db.insert(alertSite).values({ alertUpstreamId: 88, siteId, signal: 'context' });
		await runCheck(db, siteId, 'acquisition');
		const updated = await listArtifacts(db, siteId);
		const promoted = updated.filter((a) =>
			['access_log', 'acquisition', 'collections'].includes(a.kind)
		);
		expect(promoted.every((a) => a.state === 'verified' || a.state === 'not_applied')).toBe(true);
	});

	it('runSiteChecks isolates per-check failures', async () => {
		const siteId = await addSite(db);
		await runSiteChecks(db, siteId);
		const rows = await db.select().from(protectionCheck).where(eq(protectionCheck.siteId, siteId));
		expect(rows.map((r) => r.checkId).sort()).toEqual([
			'acquisition',
			'bypass',
			'decision_feed',
			'test_alert',
			'waf'
		]);
	});
});
