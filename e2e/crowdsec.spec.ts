import { expect, test } from '@playwright/test';

/**
 * Phase 3 e2e: connect to the mock LAPI (e2e/mock-lapi.mjs on :8090), run a
 * sync, and read the projection through the UI. The mock serves two local
 * alerts (one attributed to blog.example.com, one ssh with an expired
 * decision) plus one CAPI-only alert that must be skipped.
 */

test.describe.configure({ mode: 'serial' });

test('rejects bad credentials with a useful diagnostic', async ({ page }) => {
	await page.goto('/settings/crowdsec');
	// .e2e-data persists across runs — if a previous run left us connected,
	// disconnect first so the credential form is shown.
	const disconnect = page.getByRole('button', { name: 'Disconnect' });
	if (await disconnect.isVisible()) {
		await disconnect.click();
		await expect(page.getByRole('status').first()).toContainText('Disconnected');
	}
	await page.getByLabel('LAPI URL').fill('http://127.0.0.1:8090');
	await page.getByLabel('Machine ID').fill('e2e-machine');
	await page.getByLabel('Machine password').fill('wrong-password');
	await page.getByRole('button', { name: 'Test credentials' }).click();
	await expect(page.getByRole('alert')).toContainText('rejected the credentials');
});

test('connects to the mock LAPI and syncs the projection', async ({ page }) => {
	await page.goto('/settings/crowdsec');
	await page.getByLabel('LAPI URL').fill('http://127.0.0.1:8090');
	await page.getByLabel('Machine ID').fill('e2e-machine');
	await page.getByLabel('Machine password').fill('e2e-password');
	await page.getByLabel('Metrics URL').fill('http://127.0.0.1:8090/metrics');
	await page.getByLabel('Observer bouncer key').fill('e2e-bouncer-key');
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	await expect(page.getByRole('status').first()).toContainText('Connected to');

	await page.getByRole('button', { name: 'Sync now' }).click();
	// The background worker may already have synced; assert state, not counts.
	await expect(page.getByRole('status').first()).toContainText(/Sync complete|Connected/);
	await expect(page.getByText('In sync')).toBeVisible({ timeout: 15_000 });
	// ≥2 alerts, ≥1 active decision — pushed manual decisions persist in
	// .e2e-data across runs, so the counts only ever drift upward.
	await expect(
		page.getByRole('cell', { name: /[2-9]\d* alerts · [1-9]\d* active decisions/ })
	).toBeVisible();

	// Capability tiers: watcher + metrics + observer verified; AppSec has no samples.
	await expect(page.getByRole('cell', { name: 'Watcher sync' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Observer bouncer' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'AppSec visibility' })).toBeVisible();
	await expect(page.getByText('cs_appsec_* counters are flowing')).toBeHidden();
});

test('alerts page lists synced alerts with attribution', async ({ page }) => {
	await page.goto('/alerts');
	await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
	await expect(page.getByRole('link', { name: '203.0.113.7' }).first()).toBeVisible();
	await expect(page.getByRole('link', { name: 'blog.example.com' })).toBeVisible();
	// Persisted manual-decision alerts are also unattributed — match any.
	await expect(page.getByRole('cell', { name: 'unattributed' }).first()).toBeVisible();
	// CAPI-only alert must not appear.
	await expect(page.getByText('192.0.2.1')).toBeHidden();
});

test('filtering by source IP narrows the log', async ({ page }) => {
	await page.goto('/alerts?ip=203.0.113.7');
	await expect(page.getByRole('link', { name: '203.0.113.7' })).toBeVisible();
	await expect(page.getByRole('cell', { name: /198\.51\.100\.23/ })).toBeHidden();
});

test('decisions page shows active vs expired state', async ({ page }) => {
	await page.goto('/decisions');
	await expect(page.getByRole('link', { name: '203.0.113.7' })).toBeVisible();
	// The ssh decision expired in the fixture — hidden unless requested.
	await expect(page.getByRole('link', { name: '198.51.100.23' })).toBeHidden();
	await page.goto('/decisions?expired=1');
	await expect(page.getByRole('link', { name: '198.51.100.23' })).toBeVisible();
});

test('IP detail aggregates alerts and decisions for an address', async ({ page }) => {
	await page.goto('/alerts');
	await page.getByRole('link', { name: '203.0.113.7' }).first().click();
	await expect(page).toHaveURL(/\/ip\/203\.0\.113\.7/);
	await expect(page.getByRole('heading', { name: '203.0.113.7' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'http-probing' }).first()).toBeVisible();
	await expect(page.getByRole('cell', { name: 'blog.example.com' })).toBeVisible();
});

test('IP detail runs a live observer lookup when a bouncer key exists', async ({ page }) => {
	await page.goto('/ip/203.0.113.7');
	await page.getByRole('button', { name: 'Query LAPI decisions' }).click();
	await expect(page.getByText('2 live decisions for 203.0.113.7')).toBeVisible();
	// The CAPI-origin row is visible only through the observer lookup.
	await expect(page.getByRole('cell', { name: 'CAPI' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'community-blocklist' })).toBeVisible();

	// An IP with no live decisions reports an honest zero.
	await page.goto('/ip/198.51.100.23');
	await page.getByRole('button', { name: 'Query LAPI decisions' }).click();
	await expect(page.getByText('0 live decisions for 198.51.100.23')).toBeVisible();
});

test('attack map plots stored alert geo on the overview', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('img', { name: /Attack origin map: 2 locations/ })).toBeVisible();
});

test('overview switches to live data once connected', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByText('Fixture data')).toBeHidden();
	await expect(page.getByText(/Monitoring —/)).toBeVisible();
	await expect(page.getByRole('cell', { name: '21,286', exact: true })).toBeVisible(); // CAPI volume
});

test('outage surfaces a failing state and recovers', async ({ page, request }) => {
	await request.get('http://127.0.0.1:8090/_down?set=1');
	await page.goto('/settings/crowdsec');
	await page.getByRole('button', { name: 'Sync now' }).click();
	await expect(page.getByRole('alert')).toContainText('LAPI answered 503');

	await page.goto('/alerts');
	await expect(page.getByTestId('sync-error')).toContainText('Sync failing');
	// Cached rows stay visible through the outage.
	await expect(page.getByRole('link', { name: '203.0.113.7' }).first()).toBeVisible();

	await request.get('http://127.0.0.1:8090/_down?set=0');
	await page.goto('/settings/crowdsec');
	await page.getByRole('button', { name: 'Sync now' }).click();
	await expect(page.getByRole('status').first()).toContainText('Sync complete');
});
