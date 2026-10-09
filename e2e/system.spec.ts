import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
			AGENT_SERVICES: 'docker:crowdsec',
			AGENT_CALLS_LOG: CALLS,
			DOCKER_PS_FIXTURE: PS_FIXTURE,
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
		// Only acquisition artifacts are managed — exactly one such button exists.
		await page.getByRole('button', { name: 'Apply via agent' }).click();
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
});
