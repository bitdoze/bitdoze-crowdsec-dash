import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { admin } from 'better-auth/plugins/admin';
import { getRequestEvent } from '$app/server';
import { SETUP_TOKEN } from '$app/env/private';
import { db } from '#lib/server/db/index.ts';
import { config } from '#lib/server/config.ts';
import { resolveSecret } from '#lib/server/secrets.ts';
import { SetupToken } from '#lib/server/setup-token.ts';

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
		admin({ defaultRole: 'viewer', adminRoles: ['admin'] }),
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
