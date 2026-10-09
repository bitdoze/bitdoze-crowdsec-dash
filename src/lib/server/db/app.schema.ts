import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema.ts';

/**
 * Audit log of security-relevant actions (sign-in attempts, setup, 2FA
 * changes, user administration, session revocation). Append-only by
 * convention: nothing in the codebase updates or deletes rows, and the
 * lockout-recovery CLI leaves its own entry.
 */
export const audit = sqliteTable(
	'audit',
	{
		id: text('id').primaryKey(),
		at: integer('at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
		actorId: text('actor_id'),
		action: text('action').notNull(),
		detail: text('detail'),
		ip: text('ip')
	},
	(table) => [index('audit_at_idx').on(table.at), index('audit_userId_idx').on(table.userId)]
);
