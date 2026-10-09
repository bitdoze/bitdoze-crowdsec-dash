#!/usr/bin/env node
/**
 * Emergency account recovery.
 *
 *   node scripts/recover.mjs <email>
 *   # or via npm: npm run recover -- <email>
 *
 * For the given account it:
 *   - generates a new random password and stores it (Better Auth's scrypt hash),
 *   - removes two-factor rows (TOTP + recovery codes) so the account can sign in
 *     without them,
 *   - deletes every session and clears the banned flag,
 *   - clears the login throttle entries for that email,
 *   - appends an `recovery` audit row.
 *
 * The new password is printed ONCE to stdout and must be changed after
 * sign-in. Run this on the host holding DATA_DIR (inside the container:
 * `docker exec -it <container> node scripts/recover.mjs <email>`).
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { hashPassword } from 'better-auth/crypto';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes('@')) {
	console.error('Usage: node scripts/recover.mjs <email>');
	process.exit(1);
}

const dataDir = process.env.DATA_DIR ?? './data';
const databaseUrl = process.env.DATABASE_URL ?? `file:${path.join(dataDir, 'app.db')}`;
const client = createClient({ url: databaseUrl });

const { rows } = await client.execute({
	sql: 'SELECT id, email, name FROM user WHERE lower(email) = ?',
	args: [email]
});
if (rows.length === 0) {
	console.error(`No account found for ${email}.`);
	process.exit(1);
}
const user = rows[0];
const userId = String(user.id);

const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const password = Array.from(randomBytes(20), (b) => alphabet[b % alphabet.length]).join('');
const hash = await hashPassword(password);

const now = Date.now();
await client.batch(
	[
		// credential account rows carry the password hash in `password`
		{
			sql: "UPDATE account SET password = ?, updated_at = ? WHERE user_id = ? AND provider_id = 'credential'",
			args: [hash, now, userId]
		},
		{ sql: 'DELETE FROM two_factor WHERE user_id = ?', args: [userId] },
		{ sql: 'DELETE FROM session WHERE user_id = ?', args: [userId] },
		{
			sql: 'UPDATE user SET banned = 0, ban_reason = NULL, ban_expires = NULL, updated_at = ? WHERE id = ?',
			args: [now, userId]
		},
		{ sql: 'DELETE FROM rate_limit WHERE key LIKE ?', args: [`login:${email}:%`] },
		{
			sql: "INSERT INTO audit (id, at, user_id, actor_id, action, detail, ip) VALUES (?, ?, ?, NULL, 'recovery', ?, NULL)",
			args: [crypto.randomUUID(), now, userId, JSON.stringify({ via: 'scripts/recover.mjs' })]
		}
	],
	'write'
);

console.log(`Account recovered: ${user.email}`);
console.log(`New password (shown once — change it after sign-in): ${password}`);
console.log('Two-factor was disabled and all sessions were signed out.');
