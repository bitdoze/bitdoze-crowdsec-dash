import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '#lib/server/auth.ts';
import { db } from '#lib/server/db/index.ts';
import { user } from '#lib/server/db/auth.schema.ts';
import { sanitizeRedirectTo } from '#lib/server/redirects.ts';
import {
	clearLoginFailures,
	clearTwoFactorFailures,
	loginRetryAfter,
	recordLoginFailure,
	recordTwoFactorFailure,
	twoFactorRetryAfter
} from '#lib/server/throttle.ts';
import { recordAudit } from '#lib/server/audit.ts';

export const load: PageServerLoad = async (event) => {
	const [{ value: users }] = await db.select({ value: count() }).from(user);
	if (users === 0) redirect(302, '/setup');

	const redirectTo = sanitizeRedirectTo(event.url.searchParams.get('redirectTo'));
	if (event.locals.user) redirect(302, redirectTo);
	return { redirectTo };
};

function clientIp(event: RequestEvent): string {
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}

export const actions: Actions = {
	// Step 1: email + password. May return { needsTwoFactor } for the code step.
	signIn: async (event) => {
		const formData = await event.request.formData();
		const email = formData.get('email')?.toString() ?? '';
		const password = formData.get('password')?.toString() ?? '';
		const redirectTo = sanitizeRedirectTo(formData.get('redirectTo'));
		const ip = clientIp(event);

		if ((await loginRetryAfter(db, email, ip)) > 0 || (await twoFactorRetryAfter(db, ip)) > 0) {
			await recordAudit({ event, action: 'login.throttled', detail: { email } });
			return fail(429, {
				message: 'Too many attempts. Wait a few minutes and try again.',
				redirectTo
			});
		}

		let result: { twoFactorRedirect?: boolean; user?: { id: string } } | undefined;
		try {
			// The declared return type lacks `twoFactorRedirect`; the twoFactor
			// plugin adds it when a second step is required.
			result = (await auth.api.signInEmail({ body: { email, password } })) as typeof result;
		} catch {
			await recordLoginFailure(db, email, ip);
			await recordAudit({ event, action: 'login.failed', detail: { email } });
			// Generic message on purpose: do not reveal whether the account exists.
			return fail(400, { message: 'Invalid email or password', redirectTo });
		}

		if (result?.twoFactorRedirect) {
			return { needsTwoFactor: true, redirectTo };
		}

		await clearLoginFailures(db, email, ip);
		await recordAudit({
			event,
			subject: result?.user?.id ?? null,
			action: 'login.succeeded'
		});
		redirect(303, redirectTo);
	},

	// Step 2: TOTP from the authenticator app (twoFactor cookie identifies whom).
	verify: async (event) => {
		const formData = await event.request.formData();
		const code = formData.get('code')?.toString() ?? '';
		const redirectTo = sanitizeRedirectTo(formData.get('redirectTo'));
		const ip = clientIp(event);

		if ((await twoFactorRetryAfter(db, ip)) > 0) {
			await recordAudit({ event, action: 'login.throttled', detail: { secondFactor: 'totp' } });
			return fail(429, {
				needsTwoFactor: true,
				message: 'Too many attempts. Wait a few minutes and try again.',
				redirectTo
			});
		}

		let result: { user?: { id: string } } | undefined;
		try {
			result = (await auth.api.verifyTOTP({
				body: { code },
				headers: event.request.headers
			})) as typeof result;
		} catch {
			await recordTwoFactorFailure(db, ip);
			return fail(400, {
				needsTwoFactor: true,
				message: 'Invalid code',
				redirectTo
			});
		}

		await clearTwoFactorFailures(db, ip);
		await recordAudit({
			event,
			subject: result?.user?.id ?? null,
			action: 'login.succeeded',
			detail: { secondFactor: 'totp' }
		});
		redirect(303, redirectTo);
	},

	// Step 2 alternative: a one-time recovery code.
	verifyBackup: async (event) => {
		const formData = await event.request.formData();
		const code = formData.get('code')?.toString() ?? '';
		const redirectTo = sanitizeRedirectTo(formData.get('redirectTo'));
		const ip = clientIp(event);

		if ((await twoFactorRetryAfter(db, ip)) > 0) {
			await recordAudit({ event, action: 'login.throttled', detail: { secondFactor: 'backup' } });
			return fail(429, {
				needsTwoFactor: true,
				message: 'Too many attempts. Wait a few minutes and try again.',
				redirectTo
			});
		}

		let result: { user?: { id: string } } | undefined;
		try {
			result = (await auth.api.verifyBackupCode({
				body: { code },
				headers: event.request.headers
			})) as typeof result;
		} catch {
			await recordTwoFactorFailure(db, ip);
			return fail(400, {
				needsTwoFactor: true,
				message: 'Invalid recovery code',
				redirectTo
			});
		}

		await clearTwoFactorFailures(db, ip);
		await recordAudit({
			event,
			subject: result?.user?.id ?? null,
			action: 'login.succeeded',
			detail: { secondFactor: 'backup_code' }
		});
		redirect(303, redirectTo);
	}
};
