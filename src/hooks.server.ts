import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { count } from 'drizzle-orm';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth, beginSetup } from '#lib/server/auth.ts';
import { db, migrateDatabase } from '#lib/server/db/index.ts';
import { user } from '#lib/server/db/auth.schema.ts';
import { appState } from '#lib/server/state.ts';

export const init: ServerInit = async () => {
	await migrateDatabase();
	appState.migrationsApplied = true;

	const [{ value: users }] = await db.select({ value: count() }).from(user);
	if (users === 0) beginSetup();
};

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = handleBetterAuth;
