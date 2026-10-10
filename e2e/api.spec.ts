import { expect, test } from '@playwright/test';
import { e2eDb } from './helpers.ts';

/**
 * Agent surface: API keys minted in Settings drive both /api/v1 REST and the
 * /mcp MCP endpoint. Covers minting, Bearer auth, read endpoints, scope
 * enforcement (read key cannot ban), MCP initialize/tools/list/tools/call,
 * and revocation.
 */

async function mintKey(page: import('@playwright/test').Page, scope: 'read' | 'operate') {
	await page.goto('/settings');
	await page.getByLabel('Name').fill(`e2e-${scope}-${crypto.randomUUID().slice(0, 6)}`);
	await page.locator('select[name="scope"]').selectOption(scope);
	await page.getByRole('button', { name: 'Create key' }).click();
	const pre = page.locator('pre', { hasText: 'csd_' });
	await expect(pre).toBeVisible();
	return (await pre.textContent())!.trim();
}

const api = (path: string, key: string, init?: RequestInit) =>
	fetch(`http://127.0.0.1:4173${path}`, {
		...init,
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
	});

test('api keys: mint → REST → MCP → scope enforcement → revoke', async ({ page, request }) => {
	const db = e2eDb();
	await db.execute('DELETE FROM api_key').catch(() => {});
	db.close();

	// mint an operate key through the real UI
	const key = await mintKey(page, 'operate');
	expect(key.startsWith('csd_')).toBe(true);

	// unauthenticated + bad key get honest 401s
	expect((await api('/api/v1/status', 'csd_bogus')).status).toBe(401);
	const noAuth = await request.get('http://127.0.0.1:4173/api/v1/status');
	expect(noAuth.status()).toBe(401);

	// discovery doc is public
	const disco = await (await request.get('http://127.0.0.1:4173/api/v1')).json();
	expect(disco.endpoints).toBeDefined();
	expect(disco.mcp).toContain('/mcp');

	// REST reads
	const st = await api('/api/v1/status', key);
	expect(st.status).toBe(200);
	const stBody = await st.json();
	expect(stBody.version).toBeTruthy();

	const sitesRes = await api('/api/v1/sites', key);
	expect(sitesRes.status).toBe(200);

	// operate-scope write against the mock LAPI (ban a throwaway IP — kept out
	// of 198.51.100.x and 203.0.113.x which other specs assert on by name)
	const banIp = `192.0.2.${Math.floor(Math.random() * 200) + 50}`;
	const ban = await api('/api/v1/decisions', key, {
		method: 'POST',
		body: JSON.stringify({ action: 'ban', ip: banIp, duration: '10m', reason: 'e2e api' })
	});
	expect(ban.status).toBe(200);
	expect((await ban.json()).state).toBe('requested');

	// MCP: initialize → tools/list → tools/call
	const mcp = (body: object) => api('/mcp', key, { method: 'POST', body: JSON.stringify(body) });
	const init = await mcp({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities: {} }
	});
	expect(init.status).toBe(200);
	const initBody = await init.json();
	expect(initBody.result.serverInfo.name).toBe('bitdoze-crowdsec-dash');

	const list = await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
	const names = list.result.tools.map((t: { name: string }) => t.name);
	expect(names).toEqual(
		expect.arrayContaining(['status', 'list_alerts', 'ban_ip', 'unban_ip', 'lookup_ip'])
	);

	// The API-pushed ban lands in the decision projection on the next sync
	// (worker ticks every 2s in e2e) — list_decisions should then find it.
	await page.waitForTimeout(4000);
	const call = await (
		await mcp({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'list_decisions', arguments: { q: banIp } }
		})
	).json();
	expect(call.result.isError).toBe(false);
	expect(call.result.content[0].text).toContain(banIp);

	// lookup_ip returns the expected shape even for unknown addresses
	const lookup = await (
		await mcp({
			jsonrpc: '2.0',
			id: 6,
			method: 'tools/call',
			params: { name: 'lookup_ip', arguments: { ip: '192.0.2.200' } }
		})
	).json();
	expect(lookup.result.isError).toBe(false);
	expect(lookup.result.content[0].text).toContain('"decisions"');

	// a read-scope key cannot ban via MCP
	const readKey = await mintKey(page, 'read');
	const denied = await (
		await api('/mcp', readKey, {
			method: 'POST',
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: { name: 'ban_ip', arguments: { ip: '203.0.113.9', duration: '5m' } }
			})
		})
	).json();
	expect(denied.result.isError).toBe(true);
	expect(denied.result.content[0].text).toContain('operate');
	// nor via REST
	expect(
		(
			await api('/api/v1/decisions', readKey, {
				method: 'POST',
				body: JSON.stringify({ action: 'ban', ip: '203.0.113.9', duration: '5m' })
			})
		).status
	).toBe(403);

	// revoke the read key → dead on both surfaces
	await page.goto('/settings');
	await page
		.locator('tr', { hasText: 'e2e-read-' })
		.getByRole('button', { name: 'Revoke' })
		.click();
	await expect(page.getByText('Key revoked.')).toBeVisible();
	expect((await api('/api/v1/status', readKey)).status).toBe(401);
	expect(
		(
			await api('/mcp', readKey, {
				method: 'POST',
				body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })
			})
		).status
	).toBe(401);
});
