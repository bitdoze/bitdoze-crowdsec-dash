import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '#lib/server/auth.ts';
import { requireUser } from '#lib/server/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const sessions = await auth.api
		.listSessions({ headers: event.request.headers })
		.catch(() => [] as Awaited<ReturnType<typeof auth.api.listSessions>>);

	return {
		user,
		sessions: sessions.map((s) => ({
			token: s.token,
			ipAddress: s.ipAddress,
			userAgent: s.userAgent,
			createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : String(s.createdAt),
			expiresAt: s.expiresAt instanceof Date ? s.expiresAt.toISOString() : String(s.expiresAt),
			current: s.token === event.locals.session?.token
		}))
	};
};

const text = (f: FormData, name: string) => f.get(name)?.toString() ?? '';

export const actions: Actions = {
	enable2fa: async (event) => {
		const formData = await event.request.formData();
		try {
			const result = await auth.api.enableTwoFactor({
				body: { password: text(formData, 'password'), method: 'totp' },
				headers: event.request.headers
			});
			await recordAudit({ event, action: 'account.2fa.enable_started' });
			return {
				totpSetup:
					result.method === 'totp'
						? { uri: result.totpURI ?? '', backupCodes: result.backupCodes ?? [] }
						: null
			};
		} catch {
			return fail(400, {
				section: 'totp',
				message: 'Could not enable two-factor — check the password.'
			});
		}
	},

	confirm2fa: async (event) => {
		const formData = await event.request.formData();
		try {
			await auth.api.verifyTOTP({
				body: { code: text(formData, 'code') },
				headers: event.request.headers
			});
			await recordAudit({ event, action: 'account.2fa.enabled' });
			return { totpSetup: null, notice: 'Two-factor authentication is on.' };
		} catch {
			return fail(400, { section: 'totp', message: 'That code did not verify — try again.' });
		}
	},

	cancel2fa: async () => ({ totpSetup: null }),

	disable2fa: async (event) => {
		const formData = await event.request.formData();
		try {
			await auth.api.disableTwoFactor({
				body: { password: text(formData, 'password') },
				headers: event.request.headers
			});
			await recordAudit({ event, action: 'account.2fa.disabled' });
			return { notice: 'Two-factor authentication is off.' };
		} catch {
			return fail(400, {
				section: 'totp',
				message: 'Could not disable two-factor — check the password.'
			});
		}
	},

	regenerateCodes: async (event) => {
		const formData = await event.request.formData();
		try {
			const result = await auth.api.generateBackupCodes({
				body: { password: text(formData, 'password') },
				headers: event.request.headers
			});
			await recordAudit({ event, action: 'account.2fa.codes_regenerated' });
			const codes = Array.isArray(result) ? result : (result.backupCodes ?? []);
			return { backupCodes: codes };
		} catch {
			return fail(400, {
				section: 'totp',
				message: 'Could not regenerate codes — check the password.'
			});
		}
	},

	changePassword: async (event) => {
		const formData = await event.request.formData();
		const newPassword = text(formData, 'newPassword');
		if (newPassword.length < 12) {
			return fail(400, {
				section: 'password',
				message: 'New password must be at least 12 characters.'
			});
		}
		try {
			await auth.api.changePassword({
				body: {
					currentPassword: text(formData, 'currentPassword'),
					newPassword,
					revokeOtherSessions: true
				},
				headers: event.request.headers
			});
			await recordAudit({ event, action: 'account.password_changed' });
			return { notice: 'Password changed. Other sessions were signed out.' };
		} catch {
			return fail(400, {
				section: 'password',
				message: 'Could not change the password — check the current one.'
			});
		}
	},

	revokeSession: async (event) => {
		const formData = await event.request.formData();
		const token = text(formData, 'token');
		if (!token || token === event.locals.session?.token) {
			return fail(400, { message: 'Cannot revoke this session here.' });
		}
		try {
			await auth.api.revokeSession({ body: { token }, headers: event.request.headers });
			await recordAudit({ event, action: 'account.session_revoked' });
			return {};
		} catch {
			return fail(400, { message: 'Could not revoke the session.' });
		}
	},

	revokeOtherSessions: async (event) => {
		try {
			await auth.api.revokeOtherSessions({ headers: event.request.headers });
			await recordAudit({ event, action: 'account.other_sessions_revoked' });
			return {};
		} catch {
			return fail(400, { message: 'Could not revoke the other sessions.' });
		}
	}
};
