import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { admin } from 'better-auth/plugins/admin';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements } from 'better-auth/plugins/admin/access';
import { getRequestEvent } from '$app/server';
import { SETUP_TOKEN } from '$app/env/private';
import { db } from '#lib/server/db/index.ts';
import { config } from '#lib/server/config.ts';
import { resolveSecret } from '#lib/server/secrets.ts';
import { SetupToken } from '#lib/server/setup-token.ts';

/**
 * Access control: Better Auth's user/session statements plus the app's own
 * `server` statement (read → operate → configure). Role semantics are
 * enforced server-side by `src/lib/server/roles.ts`; these declarations let
 * the admin plugin validate and assign them.
 */
const statement = {
	...defaultStatements,
	server: ['read', 'operate', 'configure']
} as const;

const ac = createAccessControl(statement);

const viewerRole = ac.newRole({ server: ['read'] });
const operatorRole = ac.newRole({ server: ['read', 'operate'] });
const adminRole = ac.newRole({
	...adminAc.statements,
	server: ['read', 'operate', 'configure']
});

export const auth = betterAuth({
	baseURL: config.origin,
	secret: resolveSecret('BETTER_AUTH_SECRET', { dataDir: config.dataDir }),
	database: drizzleAdapter(db, { provider: 'sqlite' }),
	emailAndPassword: {
		enabled: true,
		minPasswordLength: 12,
		// Public sign-up stays disabled permanently; the first administrator is
		// created through /setup, later accounts through the admin plugin.
		disableSignUp: true
	},
	// Belt and suspenders with disableSignUp: reject the endpoint before routing.
	disabledPaths: ['/sign-up/email'],
	rateLimit: { enabled: true, storage: 'database' },
	plugins: [
		admin({
			ac,
			roles: { admin: adminRole, operator: operatorRole, viewer: viewerRole },
			defaultRole: 'viewer',
			adminRoles: ['admin']
		}),
		twoFactor({ issuer: 'Bitdoze CrowdSec Dash' }),
		sveltekitCookies(getRequestEvent) // must be the last plugin
	]
});

/**
 * Active first-run setup token, or null once setup has completed (or was never
 * required). Created in the server `init` hook; never persisted to the DB.
 */
export let setupToken: SetupToken | null = null;

export function beginSetup(): void {
	setupToken = new SetupToken(SETUP_TOKEN || undefined);
	console.log(`Setup required: open ${config.origin}/setup and enter token: ${setupToken.token}`);
}

export function endSetup(): void {
	setupToken = null;
}
