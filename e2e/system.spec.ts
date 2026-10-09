import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { ensureConnected } from './helpers.ts';

/**
 * Phase 6 e2e — host agent + durable jobs. The app is launched with
 * AGENT_SOCKET/AGENT_TOKEN set (see playwright.config.ts); the agent itself
 * is spawned per-suite so the first test exercises the honest "unreachable"
 * state. cscli/docker are stubbed via e2e/mock-bin on the agent's PATH.
 */
const SOCKET = '.e2e-data/agent.sock';
const CALLS = '.e2e-data/agent-calls.log';
const FILE_ROOT = '.e2e-data/agent-files';
const PS_FIXTURE = '.e2e-data/ps.jsonl';
const SIM_STATE = '.e2e-data/simulation-state.json';

let agent: ChildProcess;

async function startAgent() {
	mkdirSync('.e2e-data', { recursive: true });
	mkdirSync(FILE_ROOT, { recursive: true });
	try {
		unlinkSync(SOCKET);
	} catch {
		/* absent */
	}
	agent = spawn(process.execPath, ['server/agent.js'], {
		env: {
			...process.env,
			AGENT_SOCKET: SOCKET,
			AGENT_TOKEN: 'e2e-agent-token',
			AGENT_CSCLI: 'local',
			AGENT_DOCKER: '1',
			AGENT_FILE_ROOTS: FILE_ROOT,
			AGENT_SERVICES: 'docker:crowdsec,docker:nginx,systemd:caddy',
			AGENT_CALLS_LOG: CALLS,
			DOCKER_PS_FIXTURE: PS_FIXTURE,
			SIMULATION_STATE: SIM_STATE,
			PATH: `${process.cwd()}/e2e/mock-bin:${process.env.PATH}`
		},
		stdio: 'ignore'
	});
	for (let i = 0; i < 100 && !existsSync(SOCKET); i++) {
		await new Promise((r) => setTimeout(r, 50));
	}
	if (!existsSync(SOCKET)) throw new Error('agent socket never appeared');
}

const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8') : '');

// Runs before the agent exists — the socket path is configured but dead.
test('system: agent unreachable state is honest, not hidden', async ({ page }) => {
	await page.goto('/system');
	await expect(page.getByRole('heading', { name: 'System' })).toBeVisible();
	await expect(page.getByText('Unreachable')).toBeVisible();
	await expect(page.getByText('check the agent process and the token')).toBeVisible();
	// No inventory is fabricated while the agent is down.
	await expect(page.getByRole('heading', { name: 'Machines' })).toHaveCount(0);
});

test.describe('with a live agent', () => {
	test.beforeAll(startAgent);
	test.afterAll(() => {
		agent.kill();
		rmSync(FILE_ROOT, { recursive: true, force: true });
	});

	test('system: capabilities and cscli inventory render', async ({ page }) => {
		await page.goto('/system');
		await expect(page.getByText('Connected', { exact: true })).toBeVisible();
		await expect(page.getByText('local').first()).toBeVisible();
		await expect(page.getByText('e2e-machine')).toBeVisible();
		await expect(page.getByText('e2e-bouncer')).toBeVisible();
		await expect(page.getByText('crowdsecurity/caddy')).toBeVisible();
	});

	test('allowlist via agent runs as a durable job', async ({ page }) => {
		await ensureConnected(page);
		await page.goto('/decisions');
		await page.getByRole('button', { name: 'Allowlist via agent' }).click();
		// Idempotent: a rerun's persisted job row dedupes to "already queued".
		await expect(page.getByRole('status').first()).toContainText(/Queued|already queued/);
		// The worker drains jobs on its 2s tick — poll the jobs table.
		await expect
			.poll(async () => {
				await page.goto('/system');
				const row = page.locator('tr', { hasText: 'allowlist.add' }).first();
				return (await row.textContent()) ?? '';
			})
			.toContain('succeeded');
		expect(calls()).toContain('allowlists create dashboard-admin');
		expect(calls()).toMatch(/allowlists add dashboard-admin \S+/);
	});

	test('site install + managed apply honesty', async ({ page }) => {
		// Fresh site with an nginx topology → collections + acquisition artifacts.
		const host = `e2e-agent-${Date.now() % 100000}.example.com`;
		await page.goto('/sites');
		await page.getByLabel('Hostname').fill(host);
		await page.getByRole('button', { name: 'Add site' }).click();
		await page.getByRole('link', { name: host }).click();
		await page.getByLabel('Proxy').selectOption('nginx');
		await page.getByLabel('Runs').selectOption('native');
		await page.getByRole('button', { name: 'Save + regenerate' }).click();
		await expect(page.getByRole('status').first()).toContainText('artifacts regenerated');

		// Install hub items via the agent — succeeds through stub cscli.
		await page.getByRole('button', { name: 'Install via agent' }).click();
		await expect(page.getByRole('status').first()).toContainText('Queued install');
		await expect
			.poll(async () => {
				await page.goto('/system');
				const row = page.locator('tr', { hasText: 'hub.install' }).first();
				return (await row.textContent()) ?? '';
			})
			.toContain('succeeded');
		expect(calls()).toContain('hub update');
		expect(calls()).toMatch(/collections install \S+/);

		// Managed apply: the acquisition target is /etc/crowdsec/... which is
		// outside the agent's file roots — the job must fail and the artifact
		// must stay "not applied". This is the honesty property end-to-end.
		await page.goto(`/sites`);
		await page.getByRole('link', { name: host }).click();
		// The acquisition artifact is CrowdSec-side (no adoption needed); the
		// conf.d card stays adoption-gated, so exactly one usable apply button.
		await page
			.locator('.border-rule', { hasText: 'CrowdSec acquisition' })
			.first()
			.getByRole('button', { name: 'Apply via agent' })
			.click();
		await expect(page.getByRole('status').first()).toContainText('Queued managed apply');
		await expect
			.poll(async () => {
				await page.goto('/system');
				const row = page.locator('tr', { hasText: 'config.apply' }).first();
				return (await row.textContent()) ?? '';
			})
			.toContain('failed');
		await page.goto(`/sites`);
		await page.getByRole('link', { name: host }).click();
		await expect(
			page
				.locator('.border-rule', { hasText: 'CrowdSec acquisition' })
				.first()
				.getByText('Not applied')
		).toBeVisible();
	});

	test('traefik: docker discover → adopt → managed middleware apply', async ({ page }) => {
		const host = `e2e-tf-${Date.now() % 100000}.example.com`;
		const router = host.replace(/[^a-z0-9]/g, '-');
		const dynDir = join(process.cwd(), FILE_ROOT, 'dyn');
		// Fixture: traefik (plugin loaded) + crowdsec + an app routed to the
		// site hostname that ALSO publishes a host port (a bypass).
		writeFileSync(
			PS_FIXTURE,
			[
				JSON.stringify({
					Names: 'traefik',
					Image: 'traefik:v3.4',
					Command:
						'traefik --providers.docker=true --experimental.plugins.crowdsec-bouncer.modulename=x',
					Labels: '',
					Networks: 'proxy',
					Ports: '0.0.0.0:443->443/tcp',
					State: 'running'
				}),
				JSON.stringify({
					Names: 'crowdsec',
					Image: 'crowdsecurity/crowdsec:latest',
					Command: 'crowdsec',
					Labels: '',
					Networks: 'proxy',
					Ports: '',
					State: 'running'
				}),
				JSON.stringify({
					Names: 'app',
					Image: 'traefik/whoami:latest',
					Command: 'whoami',
					Labels: `traefik.enable=true,traefik.http.routers.${router}.rule=Host(\`${host}\`)`,
					Networks: 'proxy',
					Ports: '0.0.0.0:8080->80/tcp',
					State: 'running'
				})
			].join('\n')
		);

		await page.goto('/sites');
		await page.getByLabel('Hostname').fill(host);
		await page.getByRole('button', { name: 'Add site' }).click();
		await page.getByRole('link', { name: host }).click();

		// Docker topology module: discover, see the router + bypass warning.
		await page.getByLabel('Traefik dynamic dir').fill(dynDir);
		await page.getByRole('button', { name: 'Discover via agent' }).click();
		await expect(page.getByRole('status').first()).toContainText(`Found app routing ${host}`);
		await expect(page.getByText('bypass: 0.0.0.0:8080->80/tcp')).toBeVisible();
		await expect(page.getByText('bouncer plugin loaded')).toBeVisible();

		// Adopt → proxy/runtime become traefik/docker and artifacts regenerate
		// with the stored dynamic dir.
		await page.getByRole('button', { name: 'Adopt Traefik topology' }).click();
		await expect(page.getByRole('status').first()).toContainText('Adopted Traefik');
		const mw = page.locator('.border-rule', { hasText: 'dynamic middleware file' }).first();
		await expect(mw).toBeVisible();
		await expect(mw).toContainText(`${dynDir}/crowdsec-${router}.yaml`);

		// Managed apply — bouncer key issued via stub cscli, file written under
		// the agent's file root, artifact marked applied.
		await mw.getByRole('button', { name: 'Apply via agent' }).click();
		await expect(page.getByRole('status').first()).toContainText('Queued managed apply');
		await expect
			.poll(async () => {
				await page.goto('/system');
				const row = page.locator('tr', { hasText: 'config.apply' }).first();
				return (await row.textContent()) ?? '';
			})
			.toContain('succeeded');
		const written = readFileSync(join(dynDir, `crowdsec-${router}.yaml`), 'utf8');
		expect(written).toContain('e2e-bouncer-key-dash-');
		expect(written).not.toContain('<bouncer-key>');
		expect(calls()).toContain(`cscli bouncers add dash-${router}-traefik -o raw`);

		// The bypass check runs through the same agent inventory and fails
		// honestly with the published port as evidence.
		await page.goto('/sites');
		await page.getByRole('link', { name: host }).click();
		await page.getByRole('button', { name: 'Run checks' }).click();
		await expect(page.getByText(/publishes 0\.0\.0\.0:8080/).first()).toBeVisible();
	});

	test('nginx: adopt → managed conf.d apply validates + reloads', async ({ page }) => {
		const host = `e2e-nx-${Date.now() % 100000}.example.com`;
		const confDir = join(process.cwd(), FILE_ROOT, 'confd');
		const flag = '.e2e-data/proxy-validate-fail';
		try {
			unlinkSync(flag);
		} catch {
			/* absent */
		}
		// Poll the job row for THIS site directly — the jobs table shows only
		// kind/state, so old rows would confuse a text poll.
		const db = createClient({ url: 'file:.e2e-data/app.db' });
		const latestJob = async (hostname: string) =>
			(
				await db.execute({
					sql: "SELECT j.state FROM job j JOIN site s ON s.id = j.site_id WHERE s.hostname = ? AND j.kind = 'config.apply' ORDER BY j.created_at DESC LIMIT 1",
					args: [hostname]
				})
			).rows[0]?.state as string | undefined;

		await page.goto('/sites');
		await page.getByLabel('Hostname').fill(host);
		await page.getByRole('button', { name: 'Add site' }).click();
		await page.getByRole('link', { name: host }).click();
		await page.getByLabel('Proxy').selectOption('nginx');
		await page.getByLabel('Runs').selectOption('docker');
		await page.getByRole('button', { name: 'Save + regenerate' }).click();
		await expect(page.getByRole('status').first()).toContainText('artifacts regenerated');

		// Explicit adoption gate: the conf.d artifact targets /etc/nginx/conf.d
		// — proxy config space — so the apply button is replaced by a hint.
		const confCard = page.locator('.border-rule', { hasText: 'conf.d' }).first();
		await expect(confCard).toBeVisible();
		await expect(confCard.getByText('adopt nginx to apply')).toBeVisible();

		// Adopt with a managed dir under the agent's file root.
		await page.getByLabel('Managed config dir').fill(confDir);
		await page.getByRole('button', { name: 'Adopt nginx for managed config' }).click();
		await expect(page.getByRole('status').first()).toContainText('Adopted nginx');

		// The regenerated artifact now targets the adopted dir — apply it with
		// docker:nginx as the validate+reload service target.
		const card = page.locator('.border-rule', { hasText: 'conf.d' }).first();
		await expect(card).toContainText(`${confDir}/crowdsec-bouncer.conf`);
		await card.locator('select[name="reloadTarget"]').selectOption('docker:nginx');
		await card.getByRole('button', { name: 'Apply via agent' }).click();
		await expect(page.getByRole('status').first()).toContainText('Queued managed apply');
		await expect.poll(() => latestJob(host)).toBe('succeeded');
		// backup → write → proxy.validate → reload — in that order.
		expect(readFileSync(join(confDir, 'crowdsec-bouncer.conf'), 'utf8')).toContain('log_format');
		const log = calls();
		const vi = log.indexOf('docker exec nginx nginx -t');
		const ri = log.indexOf('docker kill -s HUP nginx');
		expect(vi).toBeGreaterThan(-1);
		expect(ri).toBeGreaterThan(vi);

		// Validation failure path: flag the stub, re-apply → job fails and the
		// artifact is not promoted to applied.
		writeFileSync(flag, '');
		await page.goto('/sites');
		await page.getByRole('link', { name: host }).click();
		const card2 = page.locator('.border-rule', { hasText: 'conf.d' }).first();
		await card2.locator('select[name="reloadTarget"]').selectOption('docker:nginx');
		await card2.getByRole('button', { name: 'Apply via agent' }).click();
		await expect.poll(() => latestJob(host)).toBe('failed');
		unlinkSync(flag);
	});

	test('phase 9: aliases attribute, WAF levels gate, drift + simulation controls', async ({
		page
	}) => {
		const run = Date.now() % 100000;
		const host = `e2e-p9-${run}.example.com`;
		const alias = `api-p9-${run}.example.com`;
		const confDir = join(process.cwd(), FILE_ROOT, 'p9confd');
		const db = createClient({ url: 'file:.e2e-data/app.db' });
		try {
			unlinkSync(SIM_STATE);
		} catch {
			/* absent */
		}

		// Site + policy: alias, WAF level 3 (CRS observe).
		await page.goto('/sites');
		await page.getByLabel('Hostname').fill(host);
		await page.getByRole('button', { name: 'Add site' }).click();
		await page.getByRole('link', { name: host }).click();
		await page.getByLabel('Proxy').selectOption('nginx');
		await page.getByLabel('Runs').selectOption('docker');
		await page.getByRole('button', { name: 'Save + regenerate' }).click();
		await expect(page.getByRole('status').first()).toContainText('artifacts regenerated');

		await page.getByLabel('Hostname aliases').fill(alias);
		await page.getByLabel('WAF level').selectOption('3');
		await page.getByRole('button', { name: 'Save policy' }).click();
		await expect(page.getByRole('status').first()).toContainText('Policy saved');
		// Level 3 appsec artifact: observe-only CRS, never in-band.
		const appsec = page.locator('.border-rule', { hasText: 'AppSec service' }).first();
		await expect(appsec).toContainText('crowdsecurity/appsec-crs');
		await expect(appsec).not.toContainText('appsec-crs-inband');

		// Level 4 is gated on observed CRS alerts — refused before any exist.
		await page.getByLabel('WAF level').selectOption('4');
		await page.getByRole('button', { name: 'Save policy' }).click();
		await expect(page.getByRole('alert').or(page.getByRole('status'))).toContainText(
			/level 3|No CRS alerts/i
		);

		// Inject an AppSec alert attributed via the ALIAS — proves alias
		// attribution and produces the observe evidence the gate needs.
		const res = await page.request.post('http://127.0.0.1:8090/_inject', {
			data: { scenario: 'crowdsecurity/appsec-crs-942110', fqdn: alias }
		});
		expect(res.ok()).toBeTruthy();
		const siteRow = await db.execute({
			sql: 'SELECT id FROM site WHERE hostname = ?',
			args: [host]
		});
		const siteId = siteRow.rows[0]!.id as string;
		await expect
			.poll(
				async () =>
					(
						await db.execute({
							sql: 'SELECT COUNT(*) n FROM alert_site WHERE site_id = ?',
							args: [siteId]
						})
					).rows[0]!.n,
				{ timeout: 15000 }
			)
			.toBeGreaterThan(0);
		// The site activity module surfaces it (still on the site page — reload).
		await page.reload();
		await expect(page.getByText('appsec-crs-942110')).toBeVisible();
		// The shared chart + range control render with a table alternative.
		await page.getByRole('link', { name: '30d', exact: true }).click();
		await expect(page).toHaveURL(/actRange=30d/);
		await expect(page.getByText('Data table')).toBeVisible();

		// Now the level-4 save goes through — observe-first flow complete.
		await page.getByLabel('WAF level').selectOption('4');
		await page.getByRole('button', { name: 'Save policy' }).click();
		await expect(page.getByRole('status').first()).toContainText('Policy saved');
		await expect(page.locator('.border-rule', { hasText: 'AppSec service' }).first()).toContainText(
			'appsec-crs-inband'
		);

		// Drift: adopt + managed apply of the conf.d file, then observe.
		await page.getByLabel('Managed config dir').fill(confDir);
		await page.getByRole('button', { name: 'Adopt nginx for managed config' }).click();
		await expect(page.getByRole('status').first()).toContainText('Adopted nginx');
		const card = page.locator('.border-rule', { hasText: 'conf.d' }).first();
		await card.getByRole('button', { name: 'Apply via agent' }).click();
		await expect(page.getByRole('status').first()).toContainText('Queued managed apply');
		await expect
			.poll(async () => {
				const r = await db.execute({
					sql: "SELECT state FROM job WHERE site_id = ? AND kind = 'config.apply' ORDER BY created_at DESC LIMIT 1",
					args: [siteId]
				});
				return r.rows[0]?.state;
			})
			.toBe('succeeded');
		await page.getByRole('button', { name: 'Check drift via agent' }).click();
		await expect(page.getByRole('status').first()).toContainText('all in sync');
		await expect(page.getByText('in sync').first()).toBeVisible();
		// Hand-edit the managed file → drift shows honestly.
		writeFileSync(join(confDir, 'crowdsec-bouncer.conf'), '# tampered by an operator\n');
		await page.getByRole('button', { name: 'Check drift via agent' }).click();
		await expect(page.getByRole('status').first()).toContainText('drifted');
		await expect(page.getByText('drifted').first()).toBeVisible();

		// Simulation toggle: per-scenario through the hub items on /system.
		await page.goto('/system');
		await expect(page.getByText('crowdsecurity/http-crawl-non_statics')).toBeVisible();
		await page
			.locator('span', { hasText: 'crowdsecurity/http-crawl-non_statics' })
			.getByRole('button', { name: 'simulate' })
			.click();
		await expect(page.getByRole('status').first()).toContainText('Queued simulation enable');
		await expect
			.poll(() => calls().includes('cscli simulation enable crowdsecurity/http-crawl-non_statics'))
			.toBe(true);
	});
});
