import { redirect } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import type { LayoutServerLoad } from './$types';
import { db } from '#lib/server/db/index.ts';
import { user } from '#lib/server/db/auth.schema.ts';
import { sanitizeRedirectTo } from '#lib/server/redirects.ts';

export const load: LayoutServerLoad = async (event) => {
	const [{ value: users }] = await db.select({ value: count() }).from(user);
	if (users === 0) redirect(302, '/setup');

	if (!event.locals.user) {
		const target = sanitizeRedirectTo(event.url.pathname + event.url.search);
		redirect(302, `/login?redirectTo=${encodeURIComponent(target)}`);
	}

	return { user: event.locals.user };
};
