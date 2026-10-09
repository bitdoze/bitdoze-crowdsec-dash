import { expect, test, type Page } from '@playwright/test';
import { authFile, e2eUser } from './helpers.ts';

const cell = (page: Page, name: RegExp) => page.getByRole('button', { name });
const evidence = (page: Page, siteId: string) => page.locator(`[id="evidence-${siteId}"]`);

/**
 * Press Ctrl+K until the palette opens. The first press can land before
 * hydration attaches the keydown listener, so retry instead of assuming.
 */
async function openPalette(page: Page) {
	const input = page.getByPlaceholder('Search or jump to…');
	for (let i = 0; i < 6; i++) {
		if (await input.isVisible()) return input;
		await page.keyboard.press('Control+k');
		await page.waitForTimeout(250);
	}
	await expect(input).toBeVisible();
	return input;
}

test.describe('fixture: before', () => {
	test('shows the unprotected verdict and observations', async ({ page }) => {
		await page.goto('/?fixture=before');
		const main = page.getByRole('main');

		await expect(page.getByText('Fixture data')).toBeVisible();
		await expect(main.getByText('Websites not protected')).toBeVisible();
		await expect(page.getByRole('heading', { name: 'reference-host' })).toBeVisible();

		// Three sites on the schedule.
		await expect(main.getByText('blog.example.com')).toBeVisible();
		await expect(main.getByText('shop.example.com')).toBeVisible();
		await expect(main.getByText('status.example.com')).toBeVisible();

		// C1 observations are listed in order.
		await expect(main.getByText('Banned IPs can still reach the sites')).toBeVisible();
		await expect(main.getByText('No detection for the websites')).toBeVisible();

		// WAF blocks are "not measured", never 0.
		await expect(main.getByText('Not measured — AppSec not configured')).toBeVisible();
	});
});

test.describe('fixture: mixed', () => {
	test('exercises every stamp state', async ({ page }) => {
		await page.goto('/?fixture=mixed');

		await expect(page.getByText('Protection degraded')).toBeVisible();
		for (const state of ['verified', 'degraded', 'failed', 'stale', 'not_configured']) {
			await expect(page.locator(`[data-state="${state}"]`).first()).toBeVisible();
		}
	});
});

test.describe('fixture: none', () => {
	test('shows the empty state', async ({ page }) => {
		await page.goto('/?fixture=none');
		await expect(page.getByText('Not connected to CrowdSec yet')).toBeVisible();
		await expect(page.getByText('Fixture data')).toHaveCount(0);
	});
});

test.describe('evidence', () => {
	test('opens on cell click and closes with Esc, restoring focus', async ({ page }) => {
		await page.goto('/?fixture=before');

		const target = cell(page, /blog\.example\.com Access logs acquired/);
		await target.click();

		const row = evidence(page, 'blog.example.com');
		await expect(row).toBeVisible();
		await expect(row.getByText('Caddyfile inspection')).toBeVisible();
		await expect(row.getByText('No access log directive for this site.')).toBeVisible();
		await expect(target).toHaveAttribute('aria-expanded', 'true');

		await page.keyboard.press('Escape');
		await expect(row).toHaveCount(0);
		await expect(target).toBeFocused();
	});

	test('Show fix reveals steps and a code block', async ({ page }) => {
		await page.goto('/?fixture=before');

		await cell(page, /blog\.example\.com Access logs acquired/).click();
		const row = evidence(page, 'blog.example.com');
		await row.getByRole('button', { name: 'Show fix' }).click();
		await expect(row.getByText('Enable JSON access logs in Caddy')).toBeVisible();
		await expect(row.getByRole('button', { name: 'Copy command' })).toBeVisible();
		await expect(row.getByText('format json')).toBeVisible();
	});
});

test.describe('re-inspect', () => {
	test('cells transition through checking and re-stamp', async ({ page }) => {
		await page.goto('/?fixture=before');
		await page.getByRole('button', { name: 'Re-inspect' }).click();
		await expect(page.locator('[data-state="checking"]').first()).toBeVisible();
		// After settling, no cell remains in the checking state.
		await expect(page.locator('[data-state="checking"]')).toHaveCount(0, {
			timeout: 10_000
		});
	});
});

test.describe('command palette', () => {
	test('opens with Ctrl+K, filters, and navigates', async ({ page }) => {
		await page.goto('/?fixture=mixed');

		const input = await openPalette(page);
		await expect(input).toBeFocused();

		// Disabled entries are listed but not activatable.
		await expect(page.getByRole('option', { name: /Search by IP address/ })).toBeDisabled();

		await page.keyboard.type('overview');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL('/');
	});

	// Runs last: it invalidates the session shared via storageState, so it
	// signs back in and re-saves the state for anything that follows.
	test('sign out is reachable from the palette', async ({ page }) => {
		await page.goto('/');
		await openPalette(page);
		await page.keyboard.type('sign out');
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/login/);

		await page.getByLabel('Email').fill(e2eUser.email);
		await page.getByLabel('Password').fill(e2eUser.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await page.waitForURL('/');
		await page.context().storageState({ path: authFile });
	});
});
