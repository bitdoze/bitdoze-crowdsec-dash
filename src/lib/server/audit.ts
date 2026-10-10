/**
 * Append to the audit log. Best-effort by design: a failure here must never
 * break the action being audited, so errors are logged and swallowed.
 *
 * `subject` is the account the entry is about (e.g. the target of a role
 * change); `actor` is who performed it (or who tried to sign in). They differ
 * whenever an administrator acts on another user.
 */
import type { RequestEvent } from '@sveltejs/kit';
import { audit } from '#lib/server/db/app.schema.ts';
import { db } from '#lib/server/db/index.ts';
import { recordEvent } from '#lib/server/notify/core.ts';

/**
 * Audit actions that also fan out to the notification inbox. Kept narrow —
 * routine reads and successful logins don't notify. `fields` whitelists which
 * detail keys reach the body (internal ids and secrets never do).
 */
const NOTIFY_ACTIONS: Record<
	string,
	{
		severity: 'info' | 'warning' | 'critical';
		title: string;
		href: string;
		fields?: string[];
	}
> = {
	'admin.user_created': {
		severity: 'info',
		title: 'User created',
		href: '/settings/users',
		fields: ['email', 'role']
	},
	'admin.user_banned': { severity: 'warning', title: 'User banned', href: '/settings/users' },
	'admin.user_unbanned': { severity: 'info', title: 'User unbanned', href: '/settings/users' },
	'admin.user_removed': { severity: 'warning', title: 'User removed', href: '/settings/users' },
	'admin.role_changed': {
		severity: 'warning',
		title: 'User role changed',
		href: '/settings/users',
		fields: ['role']
	},
	'decision.create': {
		severity: 'info',
		title: 'Manual decision pushed',
		href: '/decisions',
		fields: ['value', 'type', 'durationS']
	},
	'decision.remove': {
		severity: 'info',
		title: 'Decision removal requested',
		href: '/decisions',
		fields: ['value']
	},
	'crowdsec.connected': {
		severity: 'info',
		title: 'CrowdSec connection saved',
		href: '/settings/crowdsec',
		fields: ['lapiUrl', 'machineId']
	},
	'crowdsec.disconnected': {
		severity: 'warning',
		title: 'CrowdSec disconnected',
		href: '/settings/crowdsec'
	},
	'settings.notifications.channel': {
		severity: 'info',
		title: 'Notification channel changed',
		href: '/settings/notifications',
		fields: ['type', 'created', 'deleted']
	},
	'login.throttled': {
		severity: 'warning',
		title: 'Sign-in throttled',
		href: '/notifications',
		fields: ['email']
	},
	'site.added': {
		severity: 'info',
		title: 'Site added',
		href: '/sites',
		fields: ['hostname']
	},
	'site.removed': { severity: 'info', title: 'Site removed', href: '/sites', fields: ['hostname'] },
	'site.configured': {
		severity: 'info',
		title: 'Site topology changed',
		href: '/protection',
		fields: ['hostname', 'proxy', 'runtime']
	},
	'site.adopted': {
		severity: 'info',
		title: 'Site topology adopted for managed config',
		href: '/protection',
		fields: ['hostname', 'proxy', 'runtime', 'via']
	},
	'site.discovered': {
		severity: 'info',
		title: 'Docker topology discovered',
		href: '/sites',
		fields: ['hostname', 'traefik', 'apps']
	}
};

function describe(detail: Record<string, unknown> | undefined, fields: string[] | undefined) {
	if (!detail) return undefined;
	const keys = fields ?? Object.keys(detail);
	const parts = keys
		.filter((k) => detail[k] !== undefined && detail[k] !== null)
		.map((k) => `${k}: ${String(detail[k])}`);
	return parts.length ? parts.join(' · ').slice(0, 400) : undefined;
}

type AuditInput = {
	event?: RequestEvent;
	actor?: string | null;
	subject?: string | null;
	action: string;
	detail?: Record<string, unknown>;
};

export async function recordAudit({
	event,
	actor,
	subject,
	action,
	detail
}: AuditInput): Promise<void> {
	try {
		let ip: string | null = null;
		try {
			ip = event?.getClientAddress() ?? null;
		} catch {
			ip = null;
		}
		await db.insert(audit).values({
			id: crypto.randomUUID(),
			userId: subject ?? null,
			actorId: actor ?? event?.locals.user?.id ?? null,
			action,
			detail: detail ? JSON.stringify(detail) : null,
			ip
		});
		const n = NOTIFY_ACTIONS[action];
		if (n) {
			const site = typeof detail?.siteId === 'string' ? detail.siteId : undefined;
			await recordEvent(db, {
				eventKey: `admin.${action}.${crypto.randomUUID()}`,
				class: 'admin',
				severity: n.severity,
				title: n.title,
				body: describe(detail, n.fields),
				href: n.href,
				site
			});
		}
	} catch (e) {
		console.error(`audit write failed for ${action}:`, e);
	}
}
