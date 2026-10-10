import { expect, test } from '@playwright/test';
import { createClient } from '@libsql/client';
import { lanIp } from './helpers.ts';

/**
 * Phase 11 e2e — notification rules (class/site filters, quiet hours,
 * digest), the redacted preview, channel edit, and the Operations surface
 * (versions, retention, backup + support-bundle downloads).
 *
 * `.e2e-data` persists between runs, so notification rows are purged at the
 * start of the channel test (same starvation concern as decisions.spec).
 */

function purgeChannels() {
	const c = createClient({ url: 'file:.e2e-data/app.db' });
	return c
		.execute('DELETE FROM notification_outbox')
		.then(() => c.execute('DELETE FROM notification_channel'))
		.finally(() => c.close());
}

test('channel rules, redacted preview, and edit round-trip', async ({ page }) => {
	await purgeChannels();
	await page.goto('/settings/notifications');

	// Rules fieldset renders with class checkboxes, quiet hours, digest select.
	await expect(page.getByText('Classes', { exact: true })).toBeVisible();
	await expect(page.getByLabel('Quiet from (UTC)')).toBeVisible();
	await expect(page.getByLabel('Digest')).toBeVisible();

	// Create a channel restricted to three classes (admin unticked) + digest.
	await page.getByLabel('Name').fill('rules hook');
	await page.getByLabel('Endpoint URL').fill(`http://${lanIp()}:8090/_hook`);
	await page.getByRole('checkbox', { name: 'admin' }).uncheck();
	await page.getByLabel('Digest').selectOption('60');
	await page.getByRole('button', { name: 'Save channel' }).click();
	await expect(page.getByRole('status').first()).toContainText('saved');

	const row = page.locator('[data-channel]').filter({ hasText: 'rules hook' }).first();
	await expect(row.getByText(/outage, security, job/)).toBeVisible();
	await expect(row.getByText(/digest every 60m/)).toBeVisible();

	// Preview shows the destination with auth headers redacted — no send.
	await row.getByRole('button', { name: 'Preview' }).click();
	await expect(page.getByText(/Delivery preview — destination/)).toBeVisible();

	// Edit round-trip: pre-filled form saves back through ?/save with id.
	await row.getByRole('link', { name: 'Edit' }).click();
	await expect(page.getByText(/Edit channel — rules hook/)).toBeVisible();
	await page.getByLabel('Quiet from (UTC)').fill('22:00');
	await page.getByLabel('Quiet until (UTC)').fill('06:00');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('status').first()).toContainText('saved');
	await expect(
		page
			.locator('[data-channel]')
			.filter({ hasText: 'rules hook' })
			.getByText(/quiet 22:00–06:00/)
	).toBeVisible();
});

test('operations module: versions, retention, downloads', async ({ page }) => {
	await page.goto('/system');
	await expect(page.getByText('Operations')).toBeVisible();
	await expect(page.getByText('Component versions')).toBeVisible();

	// Update check runs and caches a result (network may fail — either the
	// release info or the error must render honestly).
	await page.getByRole('button', { name: 'Check for updates' }).click();
	await expect(page.getByRole('status').first()).toContainText(
		/Update available|Up to date|Update check failed/i,
		{ timeout: 15_000 }
	);

	// Save a retention policy and run cleanup.
	await page.getByLabel('Notifications (days)').fill('45');
	await page.getByRole('button', { name: 'Save retention' }).click();
	await expect(page.getByRole('status').first()).toContainText('Retention policy saved');
	await page.getByRole('button', { name: 'Run cleanup now' }).click();
	await expect(page.getByRole('status').first()).toContainText('Retention cleanup removed');

	// Backup download streams a sqlite file.
	const [dl] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('link', { name: 'Download database backup' }).click()
	]);
	expect(dl.suggestedFilename()).toMatch(/^app-.*\.db$/);

	// Support bundle downloads as JSON and never carries secret material.
	const [dl2] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('link', { name: 'Download support bundle' }).click()
	]);
	expect(dl2.suggestedFilename()).toMatch(/support.*\.json$/);
	const path = await dl2.path();
	const { readFileSync } = await import('node:fs');
	const bundle = JSON.parse(readFileSync(path!, 'utf8'));
	expect(bundle.version).toBeTruthy();
	expect(bundle.counts).toBeTruthy();
	expect(JSON.stringify(bundle)).not.toContain('secretEnc');
});

test('notification trends render on the inbox', async ({ page }) => {
	await page.goto('/notifications');
	await expect(page.getByText('Delivery trend — 14 days')).toBeVisible();
	await expect(page.getByText('Events per day')).toBeVisible();
	await expect(page.getByText('Failed deliveries per day')).toBeVisible();
});
