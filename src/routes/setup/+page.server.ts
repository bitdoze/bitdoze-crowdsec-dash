import { error, fail, redirect } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { APIError } from 'better-auth/api';
import { auth, endSetup, setupToken } from '#lib/server/auth.ts';
import { db } from '#lib/server/db/index.ts';
import { user } from '#lib/server/db/auth.schema.ts';
import { recordAudit } from '#lib/server/audit.ts';

const MIN_PASSWORD_LENGTH = 12;

async function userCount(): Promise<number> {
	const [{ value }] = await db.select({ value: count() }).from(user);
	return value;
}

export const load: PageServerLoad = async () => {
	// Once any user exists (or no token is active), /setup is gone for good.
	if (!setupToken?.active || (await userCount()) > 0) error(404);
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		if (!setupToken?.active || (await userCount()) > 0) {
			if (setupToken?.active) endSetup();
			error(404);
		}

		const formData = await event.request.formData();
		const token = formData.get('token')?.toString() ?? '';
		const name = formData.get('name')?.toString() ?? '';
		const email = formData.get('email')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';

		if (!name || !email || password.length < MIN_PASSWORD_LENGTH) {
			return fail(400, {
				message: `Name, a valid email, and a password of at least ${MIN_PASSWORD_LENGTH} characters are required`
			});
		}

		const attempt = setupToken.verify(token);
		if (attempt === 'too_many') error(429, 'Too many failed attempts');
		if (attempt === 'invalid') return fail(400, { message: 'Invalid setup token' });

		let adminId: string | undefined;
		try {
			// Server-side call without request headers: the admin plugin's internal
			// path, unaffected by disabled public sign-up.
			const created = await auth.api.createUser({
				body: { email, name, password, role: 'admin' }
			});
			adminId = created.user.id;
		} catch (e) {
			setupToken.release();
			if (e instanceof APIError) return fail(400, { message: e.message });
			throw e;
		}

		await recordAudit({
			event,
			subject: adminId ?? null,
			action: 'setup.admin_created',
			detail: { email }
		});
		endSetup();

		try {
			await auth.api.signInEmail({ body: { email, password } });
		} catch {
			redirect(303, '/login');
		}

		redirect(303, '/');
	}
};
