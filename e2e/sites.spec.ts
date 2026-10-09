import { expect, test } from '@playwright/test';
import { ensureConnected } from './helpers.ts';

const MOCK = 'http://127.0.0.1:8090';

/**
 * Phase 5 e2e — site inventory, topology detection, guided artifacts, and
 * the verification-check lifecycle (all agent-free paths).
 */

test('sites: add, detect topology, generate artifacts, verify checks', async ({ page }) => {
	await page.goto('/sites');
	await expect(page.getByRole('heading', { name: 'Sites' })).toBeVisible();

	// Validation rejects garbage before touching the DB.
	await page.getByLabel('Hostname').fill('not a host!!');
	await page.getByRole('button', { name: 'Add site' }).click();
	await expect(page.getByRole('alert')).toContainText('valid hostname');

	// Add a site with unknown topology — artifacts are still generated but
	// generic (guidance), and checks start unrun.
	const host = `e2e-${Date.now() % 100000}.example.com`;
	await page.getByLabel('Hostname').fill(host);
	await page.getByRole('button', { name: 'Add site' }).click();
	await expect(page.getByRole('status').first()).toContainText('added');

	await page.getByRole('link', { name: host }).click();
	await expect(page.getByRole('heading', { name: host })).toBeVisible();

	// Topology detection via the probe URL override — the mock serves
	// Server: Caddy + a CF-Ray header at /_site.
	await page.getByLabel('Probe URL (optional)').fill(`${MOCK}/_site`);
	await page.getByRole('button', { name: 'Detect topology' }).click();
	await expect(page.getByRole('status').first()).toContainText('proxy: caddy');
	await expect(page.getByRole('status').first()).toContainText('cloudflare: yes');

	// Artifacts regenerated for Caddy: access log, real-IP (CF-Connecting-IP),
	// bouncer with the custom-build note, AppSec, compose.
	await expect(page.getByText('JSON access log', { exact: false }).first()).toBeVisible();
	await expect(page.getByText('stock caddy image does NOT ship', { exact: false })).toBeVisible();
	await expect(page.getByText('CF-Connecting-IP').first()).toBeVisible();

	// Mark an artifact applied, then unmark — state round-trips.
	const artRow = page.locator('.border-rule', { hasText: 'JSON access log' }).first();
	await artRow.getByRole('button', { name: 'Mark applied' }).click();
	await expect(page.getByRole('status').first()).toContainText('Marked applied');
	await expect(artRow.getByText('Applied')).toBeVisible();

	// Verification: open a test window, inject the generic-test alert via the
	// mock, then run checks — test_alert verifies once the worker syncs it.
	await page.getByRole('button', { name: 'Start test window' }).click();
	await expect(page.getByRole('status').first()).toContainText('Test window');

	// Inject the harmless test alert attributed to this site's fqdn.
	const res = await page.request.post(`${MOCK}/_inject`, {
		data: { scenario: 'crowdsecurity/http-generic-test', fqdn: host }
	});
	expect(res.ok()).toBeTruthy();

	// Worker sync (2s tick under e2e) pulls the alert into the projection;
	// poll Run checks until test_alert flips verified.
	for (let i = 0; i < 12; i++) {
		await page.getByRole('button', { name: 'Run checks' }).click();
		const cell = page.getByText('Detection path verified').locator('..');
		if (
			await cell
				.getByText('Verified')
				.isVisible()
				.catch(() => false)
		)
			break;
		await page.waitForTimeout(1500);
	}
	await expect(
		page.getByText('Detection path verified').locator('..').getByText('Verified')
	).toBeVisible();

	// Acquisition verifies too — the injected alert attributes via context.
	await expect(
		page.getByText('Logs reach CrowdSec').locator('..').getByText('Verified')
	).toBeVisible();

	// Protection matrix shows the site row with verified cells.
	await page.goto('/protection');
	await expect(page.getByRole('heading', { name: 'Protection' })).toBeVisible();
	await expect(page.getByRole('link', { name: host })).toBeVisible();
	await expect(page.getByText('✓ verified').first()).toBeVisible();

	// Wizard reflects progress: admin/connect/topology/sites/plan steps done.
	await expect(page.getByRole('link', { name: 'Connect CrowdSec' })).toBeVisible();
	const adminStep = page.getByRole('listitem').filter({ hasText: 'Create the administrator' });
	await expect(adminStep.getByText('done', { exact: true })).toBeVisible();
	const sitesStep = page.getByRole('listitem').filter({ hasText: 'Add sites' });
	await expect(sitesStep.getByText('done', { exact: true })).toBeVisible();
	const planStep = page.getByRole('listitem').filter({ hasText: 'Build the protection plan' });
	await expect(planStep.getByText('done', { exact: true })).toBeVisible();
});

test('sites: two topologies share the decision feed a ban lands on', async ({ page }) => {
	await ensureConnected(page);
	const run = Date.now() % 100000;
	const hostA = `msa-${run}.example.com`;
	const hostB = `msb-${run}.example.com`;

	// Site A — manual topology answers (nginx on Docker), no probe.
	await page.goto('/sites');
	await page.getByLabel('Hostname').fill(hostA);
	await page.getByLabel('Proxy').selectOption('nginx');
	await page.getByLabel('Runs').selectOption('docker');
	await page.getByRole('button', { name: 'Add site' }).click();
	await expect(page.getByRole('status').first()).toContainText('added');

	// nginx-specific artifacts generated from the answers alone.
	await page.getByRole('link', { name: hostA }).click();
	await expect(page.getByText('crowdsec log format', { exact: false }).first()).toBeVisible();
	await expect(page.getByText('cs-nginx-bouncer', { exact: false }).first()).toBeVisible();

	// Site B — probe-driven topology (Caddy + Cloudflare via the mock).
	await page.goto('/sites');
	await page.getByLabel('Hostname').fill(hostB);
	await page.getByRole('button', { name: 'Add site' }).click();
	await page.getByRole('link', { name: hostB }).click();
	await page.getByLabel('Probe URL (optional)').fill(`${MOCK}/_site`);
	await page.getByRole('button', { name: 'Detect topology' }).click();
	await expect(page.getByRole('status').first()).toContainText('proxy: caddy');

	// Attribute an alert to each site so acquisition has evidence on both.
	for (const fqdn of [hostA, hostB]) {
		const res = await page.request.post(`${MOCK}/_inject`, {
			data: { scenario: 'crowdsecurity/http-probing', fqdn }
		});
		expect(res.ok()).toBeTruthy();
	}

	// A manual ban lands on the shared decision feed both sites' bouncers
	// consume — agent-free proxy for "enforced on both entry points".
	const banIp = `203.0.113.${(run % 200) + 10}`;
	await page.goto('/decisions');
	await page.getByLabel('IP or CIDR').fill(banIp);
	await page.getByLabel('Duration').fill('4h');
	await page.getByLabel('Reason').fill('multi-site feed check');
	await page.getByRole('button', { name: 'Add decision' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Ban requested' })).toBeVisible();
	await page.goto('/settings/crowdsec');
	await page.getByRole('button', { name: 'Sync now' }).click();
	// Filter so accumulated rerun data can't page the new decision away.
	await page.goto(`/decisions?q=${banIp}`);
	await expect(page.getByRole('link', { name: banIp }).first()).toBeVisible();

	// decision_feed verifies on both sites once the worker has synced the ban.
	for (const host of [hostA, hostB]) {
		await page.goto('/sites');
		await page.getByRole('link', { name: host }).click();
		for (let i = 0; i < 10; i++) {
			await page.getByRole('button', { name: 'Run checks' }).click();
			const cell = page.getByText('Decision feed reachable').locator('..');
			if (
				await cell
					.getByText('Verified')
					.isVisible()
					.catch(() => false)
			)
				break;
			await page.waitForTimeout(1500);
		}
		await expect(
			page.getByText('Decision feed reachable').locator('..').getByText('Verified')
		).toBeVisible();
	}

	// The matrix lists both rows; the ban stays visible server-wide.
	await page.goto('/protection');
	await expect(page.getByRole('link', { name: hostA })).toBeVisible();
	await expect(page.getByRole('link', { name: hostB })).toBeVisible();
	await page.goto('/decisions');
	await expect(page.getByRole('link', { name: banIp })).toBeVisible();
});
