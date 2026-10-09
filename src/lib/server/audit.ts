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
	} catch (e) {
		console.error(`audit write failed for ${action}:`, e);
	}
}
