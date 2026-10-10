import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { count } from 'drizzle-orm';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth, beginSetup } from '#lib/server/auth.ts';
import { db, migrateDatabase } from '#lib/server/db/index.ts';
import { user } from '#lib/server/db/auth.schema.ts';
import { appState } from '#lib/server/state.ts';
import { config } from '#lib/server/config.ts';

export const init: ServerInit = async () => {
	await migrateDatabase();
	appState.migrationsApplied = true;

	const [{ value: users }] = await db.select({ value: count() }).from(user);
	if (users === 0) beginSetup();

	// Worker-owned polling — starts idle until a CrowdSec connection exists.
	// SYNC_INTERVAL_MS is a test knob for e2e (outage→notification latency).
	const { startWorker } = await import('#lib/server/crowdsec/worker.ts');
	startWorker(Number(process.env.SYNC_INTERVAL_MS) || undefined);
};

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	const response = await svelteKitHandler({ event, resolve, auth, building });
	try {
		const headers: Record<string, string> = {
			'x-content-type-options': 'nosniff',
			'x-frame-options': 'DENY',
			'referrer-policy': 'same-origin',
			'permissions-policy': 'camera=(), microphone=(), geolocation=()',
			// No script-src: app.html runs an inline theme bootstrap.
			'content-security-policy':
				"frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
			...(config.origin.startsWith('https:')
				? { 'strict-transport-security': 'max-age=31536000' }
				: {})
		};
		for (const [name, value] of Object.entries(headers)) {
			if (!response.headers.has(name)) response.headers.set(name, value);
		}
	} catch {
		// Some responses (streams, immutable headers) can't be touched.
	}
	return response;
};

export const handle: Handle = handleBetterAuth;
