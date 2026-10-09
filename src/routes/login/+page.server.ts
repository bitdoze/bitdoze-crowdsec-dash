import { fail, redirect } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '#lib/server/auth.ts';
import { db } from '#lib/server/db/index.ts';
import { user } from '#lib/server/db/auth.schema.ts';
import { sanitizeRedirectTo } from '#lib/server/redirects.ts';

export const load: PageServerLoad = async (event) => {
	const [{ value: users }] = await db.select({ value: count() }).from(user);
	if (users === 0) redirect(302, '/setup');

	const redirectTo = sanitizeRedirectTo(event.url.searchParams.get('redirectTo'));
	if (event.locals.user) redirect(302, redirectTo);
	return { redirectTo };
};

export const actions: Actions = {
	default: async (event) => {
		const formData = await event.request.formData();
		const email = formData.get('email')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const redirectTo = sanitizeRedirectTo(formData.get('redirectTo'));

		try {
			await auth.api.signInEmail({ body: { email, password } });
		} catch {
			// Generic message on purpose: do not reveal whether the account exists.
			return fail(400, { message: 'Invalid email or password', redirectTo });
		}

		redirect(303, redirectTo);
	}
};
