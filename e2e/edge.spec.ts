import { expect, test } from '@playwright/test';
import { createClient } from '@libsql/client';
import { ensureConnected } from './helpers.ts';

const CF = 'http://127.0.0.1:8091';

/**
 * Phase 10 e2e — Cloudflare edge: connect (token verify + zone discovery),
 * list adoption/creation, per-zone managed rule, decision→list sync, and
 * ownership-safe uninstall. Runs against e2e/mock-cf.mjs.
 */

async function cfState(request: import('@playwright/test').APIRequestContext) {
	const res = await request.get(`${CF}/_state`);
	const body = await res.json();
	return body.result as {
		lists: { id: string; name: string; items: string[] }[];
		rulesets: Record<string, { id: string; ref?: string; expression: string }[]>;
	};
}

test.beforeEach(async ({ request }) => {
	// A clean slate per test — .e2e-data keeps dashboard rows across runs,
	// so purge CF rows the same way the notification spec purges outbox.
	await request.get(`${CF}/_reset`);
	const c = createClient({ url: 'file:.e2e-data/app.db' });
	try {
		await c.execute('DELETE FROM cloudflare_zone');
		await c.execute('DELETE FROM cloudflare_account');
	} finally {
		c.close();
	}
});

test('edge: connect → list → zone rule → sync → uninstall', async ({ page, request }) => {
	await ensureConnected(page);
	await page.goto('/edge');
	await expect(page.getByRole('heading', { name: 'Edge enforcement', exact: true })).toBeVisible();

	// Bad token is rejected honestly, nothing is stored.
	await page.getByLabel('Label').fill('e2e');
	await page.getByLabel('API token').fill('wrong-token');
	await page.getByRole('button', { name: 'Verify and connect' }).click();
	await expect(page.getByRole('status').first()).toContainText('rejected');
	await expect(page.getByText('Decision list')).toHaveCount(0);

	// Real token: verified, zones discovered.
	await page.getByLabel('API token').fill('e2e-cf-token');
	await page.getByRole('button', { name: 'Verify and connect' }).click();
	await expect(page.getByRole('status').first()).toContainText('discovered 2 zone(s)');
	await expect(page.getByText('Token active')).toBeVisible();
	await expect(page.getByText('Zone WAF Edit')).toBeVisible();

	// Adopt-or-create the account list.
	await page.getByRole('button', { name: 'Adopt or create list' }).click();
	await expect(page.getByRole('status').first()).toContainText('Edge list ready');
	await expect(page.getByText('crowdsec_dash_server').first()).toBeVisible();

	// Select zone-a, narrowed to one hostname, block action.
	const zoneRow = page.locator('li', { hasText: 'e2e-cf.example.com' });
	await zoneRow.getByRole('checkbox').check();
	await zoneRow.getByPlaceholder(/all hosts/).fill('app.e2e-cf.example.com');
	await zoneRow.getByRole('button', { name: 'Apply' }).click();
	await expect(page.getByRole('status').first()).toContainText('rule installed');
	let state = await cfState(request);
	const rulesA = state.rulesets['zone-a'] ?? [];
	expect(rulesA).toHaveLength(1);
	expect(rulesA[0].ref).toBe('crowdsec-dash-edge');
	expect(rulesA[0].expression).toContain('http.host in {"app.e2e-cf.example.com"}');

	// Sync pushes the local decision projection into the list.
	await page.getByRole('button', { name: 'Sync now' }).click();
	// The worker may have auto-queued one already — either notice is correct.
	await expect(page.getByRole('status').first()).toContainText(/queued/i);
	// The durable job drains on the worker tick (2s in e2e).
	await expect(async () => {
		state = await cfState(request);
		expect(state.lists.length).toBeGreaterThan(0);
		expect(state.lists[0].items.length).toBeGreaterThan(0);
	}).toPass({ timeout: 15_000, intervals: [500, 1000, 2000] });
	// The list only carries local-origin decisions — never the blocklist.
	expect(state.lists[0].items).not.toContain('192.0.2.1');
	await page.reload();
	await expect(page.getByText(/items · created by this dashboard/)).toBeVisible();

	// Uninstall removes our rule first, then the list we own.
	await page.getByRole('button', { name: 'Uninstall edge' }).click();
	await expect(page.getByRole('status').first()).toContainText('Removed 1 managed rule');
	state = await cfState(request);
	expect(state.rulesets['zone-a'] ?? []).toHaveLength(0);
	expect(state.lists).toHaveLength(0);

	// Disconnect is free once nothing is managed.
	await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
	await expect(page.getByRole('status').first()).toContainText('disconnected');
});
