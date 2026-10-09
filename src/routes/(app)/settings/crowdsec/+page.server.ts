import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { count, eq, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { alert, decision, metricSample, site, syncState } from '#lib/server/db/app.schema.ts';
import { requirePermission } from '#lib/server/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';
import { LapiClient, LapiError } from '#lib/server/crowdsec/client.ts';
import {
	buildClient,
	disconnect,
	getServer,
	saveConnection
} from '#lib/server/crowdsec/connection.ts';
import { scrapeMetrics } from '#lib/server/crowdsec/scrape.ts';
import { agentConfigured, agentHello } from '#lib/server/agent/client.ts';

export const load: PageServerLoad = async (event) => {
	requirePermission(event, 'configure');
	const srv = await getServer(db);
	const hello = await agentHello();
	const sync = await db.select().from(syncState);
	const [alerts] = await db.select({ n: count() }).from(alert);
	const [decisions] = await db
		.select({ n: count() })
		.from(decision)
		.where(eq(decision.expired, false));
	const [sites] = await db.select({ n: count() }).from(site);
	const [appsec] = await db
		.select({ n: sql<number>`count(*)` })
		.from(metricSample)
		.where(sql`${metricSample.name} LIKE 'cs_appsec_%'`);
	const alertsRow = sync.find((s) => s.source === 'alerts');
	const metricsRow = sync.find((s) => s.source === 'metrics');

	// Capability ladder: each tier unlocks more of the dashboard. Every row is
	// honest about missing inputs — absent endpoints read N/C, never zero.
	const capabilities = [
		{
			tier: 'T1',
			label: 'Watcher sync',
			state: !srv.connected
				? 'not_configured'
				: alertsRow?.lastError
					? 'failed'
					: alertsRow?.partial
						? 'stale'
						: alertsRow?.lastSuccessAt
							? 'verified'
							: 'not_configured',
			detail: srv.connected
				? 'Alerts and decisions are projected locally from the LAPI.'
				: 'Connect watcher credentials to start.',
			unlocks: 'Alerts · decisions · IP records · attack map'
		},
		{
			tier: 'T2',
			label: 'Metrics',
			state: !srv.metricsUrl
				? 'not_configured'
				: metricsRow?.lastError
					? 'failed'
					: metricsRow?.lastSuccessAt
						? 'verified'
						: 'not_configured',
			detail: srv.metricsUrl
				? 'Prometheus counters from the metrics endpoint.'
				: 'Add a metrics URL — unlocks counters and version.',
			unlocks: 'Parser health · CAPI volume · CrowdSec version'
		},
		{
			tier: 'T3',
			label: 'Observer bouncer',
			state: srv.hasBouncerKey ? 'verified' : 'not_configured',
			detail: srv.hasBouncerKey
				? 'Bouncer key stored (encrypted) — live per-IP decision lookups enabled.'
				: 'Add a bouncer key (cscli bouncers add) for live per-IP lookups.',
			unlocks: 'Live decision lookup on IP records'
		},
		{
			tier: 'T4',
			label: 'AppSec visibility',
			state: !srv.metricsUrl ? 'not_configured' : appsec.n > 0 ? 'verified' : 'stale',
			detail: !srv.metricsUrl
				? 'Needs the metrics endpoint (T2).'
				: appsec.n > 0
					? 'cs_appsec_* counters are flowing.'
					: 'No cs_appsec_* counters seen yet — AppSec may not be deployed.',
			unlocks: 'WAF processed/blocked/rule-hit counters'
		},
		{
			tier: 'T5',
			label: 'Host agent (cscli)',
			state: !agentConfigured()
				? 'not_configured'
				: hello
					? hello.caps.cscli
						? 'verified'
						: 'stale'
					: 'failed',
			detail: !agentConfigured()
				? 'Deploy server/agent.js on the CrowdSec host, set AGENT_SOCKET + AGENT_TOKEN.'
				: !hello
					? 'Agent configured but unreachable.'
					: hello.caps.cscli
						? `cscli via ${hello.caps.cscliMode}; ${hello.caps.roots.length} file root(s), ${hello.caps.services.length} reload target(s).`
						: 'Agent up but AGENT_CSCLI unset — read/write ops limited.',
			unlocks: 'Bouncers · hub · allowlist writes · managed applies · jobs'
		}
	] as const;

	return {
		server: srv,
		capabilities,
		sync: Object.fromEntries(
			sync.map((s) => [
				s.source,
				{
					cursor: s.cursor,
					lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
					lastError: s.lastError,
					lastErrorAt: s.lastErrorAt?.toISOString() ?? null,
					partial: s.partial
				}
			])
		),
		counts: { alerts: alerts.n, decisions: decisions.n, sites: sites.n }
	};
};

const text = (f: FormData, name: string) => f.get(name)?.toString().trim() ?? '';

function normalizeUrl(raw: string): string | null {
	if (!raw) return null;
	try {
		const u = new URL(raw);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
	} catch {
		return null;
	}
}

function diagnose(e: unknown): string {
	if (e instanceof LapiError) {
		switch (e.kind) {
			case 'auth':
				return 'LAPI rejected the credentials — check the machine ID and password (cscli machines add).';
			case 'unreachable':
				return `Could not reach the LAPI — ${e.message}. Check the address, port, and TLS.`;
			case 'http':
				return `LAPI answered ${e.status}. Is this really the CrowdSec local API?`;
			case 'bad_response':
				return 'The endpoint answered but not like CrowdSec LAPI — check the URL.';
		}
	}
	return e instanceof Error ? e.message : String(e);
}

export const actions: Actions = {
	test: async (event) => {
		requirePermission(event, 'configure');
		const formData = await event.request.formData();
		const lapiUrl = normalizeUrl(text(formData, 'lapiUrl'));
		if (!lapiUrl)
			return fail(400, { section: 'connect', message: 'A valid http(s) LAPI URL is required.' });
		const client = new LapiClient({
			baseUrl: lapiUrl,
			machineId: text(formData, 'machineId'),
			password: text(formData, 'password'),
			insecureTls: formData.get('insecureTls') === 'on'
		});
		try {
			const expire = await client.login();
			await client.alerts({ limit: 1 });
			return {
				notice: `Connected — credentials valid${expire ? `, token expires ${expire.toISOString()}` : ''}.`
			};
		} catch (e) {
			return fail(400, { section: 'connect', message: diagnose(e) });
		}
	},

	connect: async (event) => {
		requirePermission(event, 'configure');
		const formData = await event.request.formData();
		const name = text(formData, 'name') || 'server';
		const lapiUrl = normalizeUrl(text(formData, 'lapiUrl'));
		const metricsUrl = normalizeUrl(text(formData, 'metricsUrl'));
		const machineId = text(formData, 'machineId');
		const password = text(formData, 'password');
		const bouncerKey = text(formData, 'bouncerKey') || null;
		const allowInsecureTls = formData.get('insecureTls') === 'on';

		if (!lapiUrl || !machineId || !password) {
			return fail(400, {
				section: 'connect',
				message: 'LAPI URL, machine ID, and password are required.'
			});
		}
		if (text(formData, 'metricsUrl') && !metricsUrl) {
			return fail(400, {
				section: 'connect',
				message: 'The metrics URL is not a valid http(s) URL.'
			});
		}

		// Prove the credentials before storing them.
		const client = new LapiClient({
			baseUrl: lapiUrl,
			machineId,
			password,
			insecureTls: allowInsecureTls
		});
		try {
			await client.login();
			await client.alerts({ limit: 1 });
		} catch (e) {
			return fail(400, { section: 'connect', message: diagnose(e) });
		}

		await saveConnection(db, {
			name,
			lapiUrl,
			machineId,
			password,
			metricsUrl,
			bouncerKey,
			allowInsecureTls
		});
		await recordAudit({ event, action: 'crowdsec.connected', detail: { lapiUrl, machineId } });
		return { notice: `Connected to ${lapiUrl}. The first sync starts within seconds.` };
	},

	syncNow: async (event) => {
		requirePermission(event, 'configure');
		const client = await buildClient(db);
		if (!client) return fail(400, { message: 'Not connected to a LAPI.' });
		const { syncAlerts, recordSyncError } = await import('#lib/server/crowdsec/sync.ts');
		try {
			const result = await syncAlerts(db, client);
			const srv = await getServer(db);
			if (srv.metricsUrl) await scrapeMetrics(db, srv.metricsUrl).catch(() => undefined);
			return {
				notice: `Sync complete: ${result.stored} alerts stored (${result.fetched} fetched${result.skippedCentral ? `, ${result.skippedCentral} central-only skipped` : ''}).`
			};
		} catch (e) {
			await recordSyncError(db, e);
			return fail(400, { message: diagnose(e) });
		}
	},

	disconnect: async (event) => {
		requirePermission(event, 'configure');
		await disconnect(db);
		await recordAudit({ event, action: 'crowdsec.disconnected' });
		return { notice: 'Disconnected. Cached alerts and decisions stay for audit; sync is stopped.' };
	}
};
