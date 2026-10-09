import { expect, test } from '@playwright/test';

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
	await expect(page.getByText('custom build required', { exact: false })).toBeVisible();
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
});
