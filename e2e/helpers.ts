import { expect, type Page } from '@playwright/test';
import { networkInterfaces } from 'node:os';

export const authFile = 'e2e/.auth/user.json';
export const e2eUser = { email: 'e2e-admin@example.com', password: 'e2e-admin-password' };

/** First non-loopback IPv4 — the SSRF guard allows LAN destinations. */
export function lanIp(): string {
	for (const iface of Object.values(networkInterfaces())) {
		for (const addr of iface ?? []) {
			if (addr.family === 'IPv4' && !addr.internal) return addr.address;
		}
	}
	throw new Error('no LAN IPv4 found for webhook test');
}

/**
 * Idempotent connect to the mock LAPI. Specs share `.e2e-data`, so this works
 * whether or not another spec already connected.
 */
export async function ensureConnected(page: Page) {
	await page.goto('/settings/crowdsec');
	if (await page.getByRole('button', { name: 'Disconnect' }).isVisible()) return;
	await page.getByLabel('LAPI URL').fill('http://127.0.0.1:8090');
	await page.getByLabel('Machine ID').fill('e2e-machine');
	await page.getByLabel('Machine password').fill('e2e-password');
	await page.getByLabel('Metrics URL').fill('http://127.0.0.1:8090/metrics');
	await page.getByLabel('Observer bouncer key').fill('e2e-bouncer-key');
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	await expect(page.getByRole('status').first()).toContainText('Connected to');
}
