import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '#lib/server/auth.ts';
import { requirePermission } from '#lib/server/roles.ts';
import { ROLES } from '#lib/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';

export const load: PageServerLoad = async (event) => {
	const admin = requirePermission(event, 'configure');
	const { users } = await auth.api.listUsers({
		query: { limit: '200' },
		headers: event.request.headers
	});

	return {
		adminId: admin.id,
		users: users.map((u) => ({
			id: u.id,
			name: u.name,
			email: u.email,
			role: u.role ?? 'viewer',
			banned: u.banned ?? false,
			twoFactorEnabled: (u as { twoFactorEnabled?: boolean }).twoFactorEnabled ?? false,
			createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : String(u.createdAt)
		}))
	};
};

const text = (f: FormData, name: string) => f.get(name)?.toString().trim() ?? '';
const validRole = (r: string): r is (typeof ROLES)[number] =>
	(ROLES as readonly string[]).includes(r);

export const actions: Actions = {
	createUser: async (event) => {
		requirePermission(event, 'configure');
		const formData = await event.request.formData();
		const email = text(formData, 'email');
		const name = text(formData, 'name') || email.split('@')[0];
		const password = text(formData, 'password');
		const role = text(formData, 'role');

		if (!email || !validRole(role)) {
			return fail(400, { message: 'An email and a valid role are required.' });
		}
		if (password.length < 12) {
			return fail(400, { message: 'Password must be at least 12 characters.' });
		}
		try {
			const result = await auth.api.createUser({
				body: { email, password, name, role },
				headers: event.request.headers
			});
			await recordAudit({
				event,
				subject: result.user.id,
				action: 'admin.user_created',
				detail: { email, role }
			});
			return { notice: `Created ${email}.` };
		} catch {
			return fail(400, {
				message: `Could not create ${email} — the address may already be in use.`
			});
		}
	},

	setRole: async (event) => {
		const admin = requirePermission(event, 'configure');
		const formData = await event.request.formData();
		const userId = text(formData, 'userId');
		const role = text(formData, 'role');
		if (!userId || !validRole(role)) return fail(400, { message: 'Invalid user or role.' });
		if (userId === admin.id && role !== 'admin') {
			return fail(400, { message: 'You cannot demote your own account.' });
		}
		try {
			await auth.api.setRole({ body: { userId, role }, headers: event.request.headers });
			await recordAudit({ event, subject: userId, action: 'admin.role_changed', detail: { role } });
			return { notice: 'Role updated.' };
		} catch {
			return fail(400, { message: 'Could not change the role.' });
		}
	},

	setBanned: async (event) => {
		const admin = requirePermission(event, 'configure');
		const formData = await event.request.formData();
		const userId = text(formData, 'userId');
		const banned = text(formData, 'banned') === 'true';
		if (!userId) return fail(400, { message: 'Invalid user.' });
		if (userId === admin.id) return fail(400, { message: 'You cannot ban your own account.' });
		try {
			if (banned) {
				await auth.api.banUser({ body: { userId }, headers: event.request.headers });
			} else {
				await auth.api.unbanUser({ body: { userId }, headers: event.request.headers });
			}
			await recordAudit({
				event,
				subject: userId,
				action: banned ? 'admin.user_banned' : 'admin.user_unbanned'
			});
			return { notice: banned ? 'User banned and signed out.' : 'User unbanned.' };
		} catch {
			return fail(400, { message: 'Could not update the user.' });
		}
	},

	removeUser: async (event) => {
		const admin = requirePermission(event, 'configure');
		const formData = await event.request.formData();
		const userId = text(formData, 'userId');
		if (!userId) return fail(400, { message: 'Invalid user.' });
		if (userId === admin.id) return fail(400, { message: 'You cannot remove your own account.' });
		try {
			await auth.api.removeUser({ body: { userId }, headers: event.request.headers });
			await recordAudit({ event, subject: userId, action: 'admin.user_removed' });
			return { notice: 'User removed.' };
		} catch {
			return fail(400, { message: 'Could not remove the user.' });
		}
	}
};
