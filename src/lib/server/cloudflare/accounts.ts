/**
 * Cloudflare account lifecycle — connect (verify token + discover zones),
 * list adoption/creation, per-zone rule install, sync, and
 * ownership-safe uninstall. All CF calls go through `cfClient`; secrets
 * never leave this module decrypted except in memory.
 */

import { eq } from 'drizzle-orm';
import { CF_API_BASE } from '$app/env/private';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { db } from '#lib/server/db/index.ts';
import { cloudflareAccount, cloudflareZone } from '#lib/server/db/app.schema.ts';
import { config } from '#lib/server/config.ts';
import { resolveSecret } from '#lib/server/secrets.ts';
import { cfClient, CfError, listNameFor, type CfClientOptions, type CfList } from './client.ts';
import { edgeRule, RULE_REF } from './sync.ts';

const encKey = () => resolveSecret('BETTER_AUTH_SECRET', { dataDir: config.dataDir });

async function encryptToken(token: string): Promise<string> {
	return symmetricEncrypt({ key: encKey(), data: JSON.stringify({ token }) });
}

async function decryptToken(account: { tokenEnc: string }): Promise<string> {
	const parsed = JSON.parse(await symmetricDecrypt({ key: encKey(), data: account.tokenEnc }));
	return parsed.token;
}

/** Injectable seam for tests — production uses the real API base. */
const baseUrl = () => CF_API_BASE || undefined;
export const makeClient = (opts: CfClientOptions) => cfClient({ baseUrl: baseUrl(), ...opts });
let clientFactory: (opts: CfClientOptions) => ReturnType<typeof cfClient> = makeClient;
export function setClientFactoryForTests(fn: typeof clientFactory | null) {
	clientFactory = fn ?? makeClient;
}

async function clientFor(account: { tokenEnc: string }) {
	return clientFactory({ token: await decryptToken(account) });
}

export class EdgeError extends Error {
	constructor(
		message: string,
		readonly kind: 'auth' | 'api' | 'state' = 'api'
	) {
		super(message);
		this.name = 'EdgeError';
	}
}

function toEdgeError(e: unknown): EdgeError {
	if (e instanceof CfError) {
		if (e.status === 401 || e.status === 403)
			return new EdgeError(`Cloudflare rejected the token (${e.message})`, 'auth');
		return new EdgeError(e.message, 'api');
	}
	return e instanceof EdgeError ? e : new EdgeError(String(e));
}

async function recordError(accountId: string, e: unknown) {
	const err = toEdgeError(e);
	await db
		.update(cloudflareAccount)
		.set({ lastError: err.message, tokenStatus: err.kind === 'auth' ? 'error' : undefined })
		.where(eq(cloudflareAccount.id, accountId));
	return err;
}

/**
 * Connect: verify the token, persist it encrypted, then discover zones.
 * Zone rows upsert by zoneId so re-verification refreshes rather than
 * duplicates; operator selections survive rediscovery.
 */
export async function connectAccount(
	name: string,
	token: string
): Promise<{ id: string; zones: number; permissions: string[] }> {
	const cf = clientFactory({ token: token.trim() });
	let verified;
	try {
		verified = await cf.verifyToken();
	} catch (e) {
		throw toEdgeError(e);
	}
	if (verified.status !== 'active') {
		throw new EdgeError(`Cloudflare reports the token is ${verified.status}, not active`, 'auth');
	}

	const id = crypto.randomUUID();
	await db.insert(cloudflareAccount).values({
		id,
		name: name.trim() || 'cloudflare',
		tokenEnc: await encryptToken(token.trim()),
		tokenStatus: verified.status,
		permissions: JSON.stringify(verified.permissionGroups),
		verifiedAt: new Date()
	});

	const account = await db.query.cloudflareAccount.findFirst({
		where: eq(cloudflareAccount.id, id)
	});
	const zones = await discoverZones(account!);
	return { id, zones, permissions: verified.permissionGroups };
}

/** Re-run token verification + zone discovery for an existing account. */
export async function reverifyAccount(accountId: string): Promise<{ zones: number }> {
	const account = await db.query.cloudflareAccount.findFirst({
		where: eq(cloudflareAccount.id, accountId)
	});
	if (!account) throw new EdgeError('Account not found', 'state');
	try {
		const cf = await clientFor(account);
		const verified = await cf.verifyToken();
		await db
			.update(cloudflareAccount)
			.set({
				tokenStatus: verified.status,
				permissions: JSON.stringify(verified.permissionGroups),
				verifiedAt: new Date(),
				lastError: verified.status === 'active' ? null : `token ${verified.status}`
			})
			.where(eq(cloudflareAccount.id, accountId));
		if (verified.status !== 'active') throw new EdgeError(`token is ${verified.status}`, 'auth');
		return { zones: await discoverZones(account) };
	} catch (e) {
		throw await recordError(accountId, e);
	}
}

/** Discover zones and upsert rows; returns how many were seen. */
export async function discoverZones(account: {
	id: string;
	tokenEnc: string;
	cfAccountId: string;
}): Promise<number> {
	const cf = clientFactory({ token: await decryptToken(account) });
	const zones = await cf.listZones();
	const existing = await db.query.cloudflareZone.findMany({
		where: eq(cloudflareZone.accountId, account.id)
	});
	const byZoneId = new Map(existing.map((z) => [z.zoneId, z]));

	let cfAccountId = account.cfAccountId;
	for (const z of zones) {
		cfAccountId ||= z.accountId;
		const prev = byZoneId.get(z.id);
		if (prev) {
			await db
				.update(cloudflareZone)
				.set({ name: z.name, plan: z.plan })
				.where(eq(cloudflareZone.id, prev.id));
		} else {
			await db.insert(cloudflareZone).values({
				id: crypto.randomUUID(),
				accountId: account.id,
				zoneId: z.id,
				name: z.name,
				plan: z.plan
			});
		}
	}
	if (cfAccountId && cfAccountId !== account.cfAccountId) {
		await db
			.update(cloudflareAccount)
			.set({ cfAccountId })
			.where(eq(cloudflareAccount.id, account.id));
	}
	return zones.length;
}

export function parseHostnames(raw: string): string[] {
	return [
		...new Set(
			raw
				.split(/[\s,]+/)
				.map((h) => h.trim().toLowerCase())
				.filter((h) =>
					/^[a-z0-9]([a-z0-9\-.]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-.]*[a-z0-9])?)+$/.test(h)
				)
		)
	].slice(0, 32);
}

/**
 * URI path prefixes for route narrowing. Only `/`-prefixed paths without
 * quotes or backslashes survive — either could break out of the quoted
 * string in the rendered CF expression.
 */
export function parsePaths(raw: string): string[] {
	return [
		...new Set(
			raw
				.split(/[\s,]+/)
				.map((p) => p.trim())
				.filter(
					(p) => p.startsWith('/') && !p.includes('"') && !p.includes('\\') && p.length <= 128
				)
		)
	].slice(0, 16);
}

/**
 * Ensure the account-level IP list exists: adopt a compatible existing
 * `crowdsec_dash_*` list or create one. Adopted lists are never deleted
 * on uninstall.
 */
export async function ensureList(accountId: string): Promise<CfList> {
	const account = await db.query.cloudflareAccount.findFirst({
		where: eq(cloudflareAccount.id, accountId)
	});
	if (!account) throw new EdgeError('Account not found', 'state');
	if (account.listId) {
		return { id: account.listId, name: account.listName ?? '', kind: 'ip' };
	}
	if (!account.cfAccountId) throw new EdgeError('No Cloudflare account discovered yet', 'state');
	try {
		const cf = await clientFor(account);
		const lists = await cf.listLists(account.cfAccountId);
		const compatible = lists.find((l) => l.kind === 'ip' && l.name.startsWith('crowdsec_dash_'));
		const list =
			compatible ??
			(await cf.createList(
				account.cfAccountId,
				listNameFor('server'),
				'CrowdSec decisions — managed by bitdoze-crowdsec-dash. Do not edit by hand.'
			));
		await db
			.update(cloudflareAccount)
			.set({
				listId: list.id,
				listName: list.name,
				listOwned: !compatible
			})
			.where(eq(cloudflareAccount.id, accountId));
		return list;
	} catch (e) {
		throw await recordError(accountId, e);
	}
}

/**
 * Merge our managed rule into the zone's custom-rules ruleset.
 * `putCustomRules` replaces the whole ruleset, so other rules are
 * preserved and ours is matched by `ref` for idempotent updates.
 */
export async function applyZoneRule(zoneRowId: string): Promise<{ ruleId: string }> {
	const zone = await db.query.cloudflareZone.findFirst({
		where: eq(cloudflareZone.id, zoneRowId)
	});
	if (!zone?.selected) throw new EdgeError('Zone is not selected for edge enforcement', 'state');
	const account = await db.query.cloudflareAccount.findFirst({
		where: eq(cloudflareAccount.id, zone.accountId)
	});
	if (!account?.listName)
		throw new EdgeError('Create the IP list before installing rules', 'state');
	try {
		const cf = await clientFor(account);
		const ruleset = await cf.getCustomRules(zone.zoneId);
		const others = (ruleset?.rules ?? []).filter((r) => r.ref !== RULE_REF);
		const hostnames = JSON.parse(zone.hostnames) as string[];
		const paths = JSON.parse(zone.paths ?? '[]') as string[];
		const mine = edgeRule(account.listName, hostnames, zone.action, paths);
		const updated = await cf.putCustomRules(zone.zoneId, [...others, mine]);
		const ruleId = updated.rules.find((r) => r.ref === RULE_REF)?.id ?? '';
		await db
			.update(cloudflareZone)
			.set({ ruleId, rulesInUse: updated.rules.length })
			.where(eq(cloudflareZone.id, zoneRowId));
		return { ruleId };
	} catch (e) {
		throw await recordError(account.id, e);
	}
}

/** Remove our rule from a zone's ruleset (other rules untouched). */
export async function removeZoneRule(zoneRowId: string): Promise<void> {
	const zone = await db.query.cloudflareZone.findFirst({
		where: eq(cloudflareZone.id, zoneRowId)
	});
	if (!zone) return;
	const account = await db.query.cloudflareAccount.findFirst({
		where: eq(cloudflareAccount.id, zone.accountId)
	});
	if (!account) return;
	try {
		const cf = await clientFor(account);
		const ruleset = await cf.getCustomRules(zone.zoneId);
		const remaining = (ruleset?.rules ?? []).filter((r) => r.ref !== RULE_REF);
		if (ruleset) await cf.putCustomRules(zone.zoneId, remaining);
	} catch (e) {
		throw await recordError(account.id, e);
	}
	await db.update(cloudflareZone).set({ ruleId: null }).where(eq(cloudflareZone.id, zoneRowId));
}

/** Update zone selection; installing/removing the managed rule follows. */
export async function setZoneSelection(
	zoneRowId: string,
	opts: {
		selected: boolean;
		hostnames?: string[];
		paths?: string[];
		action?: 'block' | 'challenge' | 'log';
	}
): Promise<void> {
	const zone = await db.query.cloudflareZone.findFirst({
		where: eq(cloudflareZone.id, zoneRowId)
	});
	if (!zone) throw new EdgeError('Zone not found', 'state');
	await db
		.update(cloudflareZone)
		.set({
			selected: opts.selected,
			...(opts.hostnames ? { hostnames: JSON.stringify(opts.hostnames) } : {}),
			...(opts.paths ? { paths: JSON.stringify(opts.paths) } : {}),
			...(opts.action ? { action: opts.action } : {})
		})
		.where(eq(cloudflareZone.id, zoneRowId));
	if (opts.selected) await applyZoneRule(zoneRowId);
	else if (zone.ruleId) await removeZoneRule(zoneRowId);
}

/**
 * Ownership-safe uninstall: remove our managed rules first (a list
 * cannot be deleted while a rule references it), then delete the list
 * only when we created it. The account row and token remain — the
 * operator disconnects explicitly.
 */
export async function uninstallEdge(accountId: string): Promise<{ rulesRemoved: number }> {
	const account = await db.query.cloudflareAccount.findFirst({
		where: eq(cloudflareAccount.id, accountId)
	});
	if (!account) throw new EdgeError('Account not found', 'state');
	const zones = await db.query.cloudflareZone.findMany({
		where: eq(cloudflareZone.accountId, accountId)
	});
	let rulesRemoved = 0;
	for (const z of zones) {
		if (z.ruleId) {
			await removeZoneRule(z.id);
			rulesRemoved++;
		}
	}
	if (account.listId && account.listOwned && account.cfAccountId) {
		try {
			const cf = await clientFor(account);
			await cf.deleteList(account.cfAccountId, account.listId);
		} catch (e) {
			// Already gone upstream is fine — teardown is idempotent.
			if (!(e instanceof CfError && e.status === 404)) throw await recordError(accountId, e);
		}
	}
	await db
		.update(cloudflareAccount)
		.set({ listId: null, listName: null, listItemCount: null, listDropped: 0 })
		.where(eq(cloudflareAccount.id, accountId));
	await db
		.update(cloudflareZone)
		.set({ selected: false, ruleId: null })
		.where(eq(cloudflareZone.accountId, accountId));
	return { rulesRemoved };
}

/** Disconnect: refuses while managed resources still exist — uninstall first. */
export async function disconnectAccount(accountId: string): Promise<void> {
	const account = await db.query.cloudflareAccount.findFirst({
		where: eq(cloudflareAccount.id, accountId)
	});
	if (!account) return;
	if (account.listId)
		throw new EdgeError('Uninstall edge enforcement before disconnecting', 'state');
	await db.delete(cloudflareAccount).where(eq(cloudflareAccount.id, accountId));
}

/** Decrypt the token for the sync path (worker-side use only). */
export async function accountToken(account: { tokenEnc: string }): Promise<string> {
	return decryptToken(account);
}

export { cfClient };
