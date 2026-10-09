/**
 * Server-side authorization. `requireUser` guards every protected load;
 * `requirePermission` guards every load/action/endpoint that does more than
 * read — the sidebar merely hides what the server also denies.
 *
 * Role semantics and the pure helpers live in `#lib/roles.ts` (shared with
 * the UI); they are re-exported here for call-site convenience.
 */
import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { hasPermission, type Permission } from '#lib/roles.ts';

export { ROLES, hasPermission, primaryRole, rolesFromValue } from '#lib/roles.ts';
export type { Permission, Role } from '#lib/roles.ts';

/** Signed-in user or a redirect to /login carrying the current target. */
export function requireUser(event: RequestEvent): NonNullable<App.Locals['user']> {
	if (!event.locals.user) {
		const target = event.url.pathname + event.url.search;
		redirect(302, `/login?redirectTo=${encodeURIComponent(target)}`);
	}
	return event.locals.user;
}

/** Signed-in user holding `permission`, or a 403/redirect. */
export function requirePermission(event: RequestEvent, permission: Permission) {
	const user = requireUser(event);
	if (!hasPermission(user.role, permission)) {
		error(403, `This action requires the ${permission} permission.`);
	}
	return user;
}
