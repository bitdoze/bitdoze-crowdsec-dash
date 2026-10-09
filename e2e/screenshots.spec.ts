import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * Review captures. Runs only when SCREENSHOTS=1 is set:
 *   SCREENSHOTS=1 npm run test:e2e
 * Saves light/dark x desktop/mobile PNGs to .impeccable/review/ (gitignored).
 */

const OUT = '.impeccable/review';
const viewports = {
	desktop: { width: 1440, height: 900 },
	mobile: { width: 390, height: 844 }
} as const;

test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to capture review shots');

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

for (const scheme of ['light', 'dark'] as const) {
	for (const [device, viewport] of Object.entries(viewports)) {
		test(`overview fixture=before — ${scheme} ${device}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.emulateMedia({ colorScheme: scheme });
			await page.goto('/?fixture=before');
			await expect(page.getByText('Websites not protected')).toBeVisible();
			// Let the lazy chart mount before capturing.
			await page.waitForTimeout(1200);
			await page.screenshot({
				path: `${OUT}/overview-before-${scheme}-${device}.png`,
				fullPage: true
			});
		});
	}
}

test('overview fixture=mixed — light desktop', async ({ page }) => {
	await page.setViewportSize(viewports.desktop);
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/?fixture=mixed');
	await expect(page.getByText('Protection degraded')).toBeVisible();
	await page.waitForTimeout(1200);
	await page.screenshot({ path: `${OUT}/overview-mixed-light-desktop.png`, fullPage: true });
});

test('empty state — light desktop', async ({ page }) => {
	await page.setViewportSize(viewports.desktop);
	await page.emulateMedia({ colorScheme: 'light' });
	await page.goto('/?fixture=none');
	await expect(page.getByText('Not connected to CrowdSec yet')).toBeVisible();
	await page.screenshot({ path: `${OUT}/overview-empty-light-desktop.png`, fullPage: true });
});

test.describe('auth screens', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('login — light desktop', async ({ page }) => {
		await page.setViewportSize(viewports.desktop);
		await page.emulateMedia({ colorScheme: 'light' });
		await page.goto('/login');
		await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
		await page.screenshot({ path: `${OUT}/login-light-desktop.png`, fullPage: true });
	});
});
