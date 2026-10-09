/**
 * Application roles and the permission ladder, shared between server and UI.
 *
 * - `read`      — every signed-in user: view dashboards and their own account.
 * - `operate`   — operator and above: act on protection (bans, allowlists,
 *   re-inspect, site config). Nothing grants it yet; guards exist so phase 3+
 *   mutations inherit enforcement.
 * - `configure` — admin only: users, roles, system settings.
 *
 * Enforcement lives in `src/lib/server/roles.ts` (`requireUser`,
 * `requirePermission`); these pure helpers only describe the ladder.
 */
export const ROLES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export type Permission = 'read' | 'operate' | 'configure';

const GRANTS: Record<Role, ReadonlySet<Permission>> = {
	admin: new Set<Permission>(['read', 'operate', 'configure']),
	operator: new Set<Permission>(['read', 'operate']),
	viewer: new Set<Permission>(['read'])
};

/** Better Auth can store several roles comma-separated; grant the union. */
export function rolesFromValue(value: string | null | undefined): Role[] {
	if (!value) return ['viewer'];
	const parsed = value
		.split(',')
		.map((v) => v.trim())
		.filter((v): v is Role => (ROLES as readonly string[]).includes(v));
	return parsed.length > 0 ? parsed : ['viewer'];
}

export function hasPermission(
	roleValue: string | null | undefined,
	permission: Permission
): boolean {
	return rolesFromValue(roleValue).some((role) => GRANTS[role].has(permission));
}

/** Highest role the user holds, for display. */
export function primaryRole(roleValue: string | null | undefined): Role {
	const roles = rolesFromValue(roleValue);
	return ROLES.find((r) => roles.includes(r)) ?? 'viewer';
}
