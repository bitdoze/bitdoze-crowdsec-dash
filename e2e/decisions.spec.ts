import { expect, test } from '@playwright/test';
import { networkInterfaces } from 'node:os';
import { createClient } from '@libsql/client';
import { ensureConnected } from './helpers.ts';

/**
 * Phase 4 e2e: manual decisions via POST /v1/alerts, unban via
 * DELETE /v1/decisions/:id, centralized allowlist checks, and the
 * notification inbox + channel delivery. The mock LAPI persists pushed
 * decisions so the requested → confirmed lifecycle exercises the real path.
 */

test.describe.configure({ mode: 'serial' });

/** First non-loopback IPv4 — the SSRF guard allows LAN destinations. */
function lanIp(): string {
	for (const iface of Object.values(networkInterfaces())) {
		for (const addr of iface ?? []) {
			if (addr.family === 'IPv4' && !addr.internal) return addr.address;
		}
	}
	throw new Error('no LAN IPv4 found for webhook test');
}

test('connected for the phase-4 flows', async ({ page, request }) => {
	await ensureConnected(page);
	// The webServer reuse race can leave a dead mock — surface it here rather
	// than as a confusing push failure in a later test.
	const res = await request.get('http://127.0.0.1:8090/v1/metrics');
	expect(res.ok(), 'mock LAPI reachable').toBe(true);
});

test('manual ban: validation rejects garbage before touching the LAPI', async ({ page }) => {
	await page.goto('/decisions');
	await page.getByLabel('IP or CIDR').fill('not-an-ip');
	await page.getByLabel('Duration').fill('4h');
	await page.getByRole('button', { name: 'Add decision' }).click();
	await expect(page.getByRole('alert')).toContainText('valid IPv4/IPv6');
});

test('manual ban pushes, confirms on sync, then unban reconciles', async ({ page }) => {
	// TEST-NET-3 IP randomized per run — .e2e-data persists across runs, and
	// the in-memory mock forgets pushed decisions on restart.
	const ip = `203.0.113.${50 + Math.floor(Math.random() * 150)}`;
	const ipRe = new RegExp(ip.replaceAll('.', '\\.'));

	await page.goto('/decisions');
	await page.getByLabel('IP or CIDR').fill(ip);
	await page.getByLabel('Duration').fill('4h');
	await page.getByLabel('Reason').fill('e2e test');
	await page.getByRole('button', { name: 'Add decision' }).click();
	// The SyncBanner also has role=status — filter for the action result.
	await expect(
		page.getByRole('status').filter({ hasText: `Ban requested for ${ip}` })
	).toBeVisible();

	// Requested, awaiting projection confirmation.
	const requestRow = page.getByRole('row', { name: ipRe }).first();
	await expect(requestRow.getByText('Pushed')).toBeVisible();

	// Sync pulls the pushed alert back → confirmed.
	await page.goto('/settings/crowdsec');
	await page.getByRole('button', { name: 'Sync now' }).click();
	await page.goto('/decisions');
	await expect(requestRow.getByText('Confirmed')).toBeVisible();
	// And it shows in the active decisions table.
	await expect(page.getByRole('link', { name: ip })).toBeVisible();

	// Unban → removing → removed after the next sync drops it.
	const decisionRow = page.getByRole('row', { name: ipRe }).filter({ hasText: 'manual' });
	await decisionRow.getByRole('button', { name: 'Remove' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Removal requested' })).toBeVisible();
	await page.goto('/settings/crowdsec');
	await page.getByRole('button', { name: 'Sync now' }).click();
	await page.goto('/decisions');
	await expect(requestRow.getByText('Removed')).toBeVisible();
	await expect(page.getByRole('link', { name: ip })).toBeHidden();
});

test('allowlist check reports coverage and mechanisms', async ({ page }) => {
	// 198.51.100.23 is on the mock's "office-egress" centralized allowlist.
	await page.goto('/ip/198.51.100.23');
	await page.getByRole('button', { name: 'Check centralized allowlists' }).click();
	await expect(page.getByText('Covered by 1 centralized allowlist')).toBeVisible();
	await expect(page.getByText('office-egress')).toBeVisible();

	// A non-allowlisted IP reports an honest negative plus mechanism guidance.
	await page.goto('/ip/203.0.113.7');
	await page.getByRole('button', { name: 'Check centralized allowlists' }).click();
	await expect(page.getByText('Not on any centralized allowlist')).toBeVisible();
	// "parser whitelists" wraps across two text nodes in source — match the lead-in.
	await expect(page.getByText(/Allowlists live in three places/)).toBeVisible();
});

test('allowlist-my-IP returns guided commands (no LAPI write path)', async ({ page }) => {
	await page.goto('/decisions');
	await page.getByRole('button', { name: 'Allowlist my current IP' }).click();
	await expect(page.getByText(/Allowlist .+ on the server/)).toBeVisible();
	await expect(page.getByText(/cscli allowlists create dashboard-admin/)).toBeVisible();
});

test('notification channel: SSRF rejection, real delivery, inbox row', async ({ page }) => {
	await page.goto('/settings/notifications');

	// Loopback must be rejected at save time.
	await page.getByLabel('Name').fill('bad hook');
	await page.getByLabel('Endpoint URL').fill('http://127.0.0.1:8090/_hook');
	await page.getByRole('button', { name: 'Save channel' }).click();
	await expect(page.getByRole('alert')).toContainText(/not allowed|Loopback/i);

	// LAN destination delivers through the real outbox path.
	await page.getByLabel('Name').fill('e2e hook');
	await page.getByLabel('Endpoint URL').fill(`http://${lanIp()}:8090/_hook`);
	await page.getByRole('button', { name: 'Save channel' }).click();
	await expect(page.getByRole('status').first()).toContainText('saved');

	// `.e2e-data` persists — the channel may exist from a previous run.
	const channelRow = page.locator('[data-channel]').filter({ hasText: 'e2e hook webhook' }).first();
	await expect(channelRow).toBeVisible();
	await channelRow.getByRole('button', { name: 'Send test' }).click();
	await expect(page.getByRole('status').first()).toContainText('Test delivered');

	// The inbox shows the test event + delivery state (newest first).
	await page.goto('/notifications');
	const notifRow = page.locator('div.border-b', { hasText: 'Test delivery to e2e hook' }).first();
	await expect(notifRow).toBeVisible();
	// Duplicate "e2e hook" channels from earlier runs each get a delivery.
	await expect(notifRow.getByText(/delivered: [1-9]/)).toBeVisible();

	// Mark-all-read works.
	await page.getByRole('button', { name: 'Mark all read' }).click();
	await expect(page.getByText('0 unread')).toBeVisible();
});

/** Wipe outage notifications so assertions can't pass on stale rows. */
async function clearOutageNotifications() {
	const c = createClient({ url: 'file:.e2e-data/app.db' });
	try {
		await c.execute(
			"DELETE FROM notification WHERE event_key LIKE 'alerts.down' OR event_key LIKE 'alerts.recovered.%' OR event_key LIKE 'metrics.down' OR event_key LIKE 'metrics.recovered.%'"
		);
	} finally {
		c.close();
	}
}

test('outage and recovery land in the notification inbox', async ({ page, request }) => {
	await clearOutageNotifications();
	// Worker ticks every 2s in e2e (SYNC_INTERVAL_MS) — the inbox is static
	// HTML, so poll by reloading until the worker's tick lands the event.
	await request.get('http://127.0.0.1:8090/_down?set=1');
	await expect(async () => {
		await page.goto('/notifications');
		await expect(page.getByText('LAPI sync failing')).toBeVisible({ timeout: 500 });
	}).toPass({ timeout: 15_000 });

	await request.get('http://127.0.0.1:8090/_down?set=0');
	await expect(async () => {
		await page.goto('/notifications');
		await expect(page.getByText('LAPI sync recovered')).toBeVisible({ timeout: 500 });
	}).toPass({ timeout: 15_000 });
});
