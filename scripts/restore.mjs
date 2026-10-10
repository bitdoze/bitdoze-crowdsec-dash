#!/usr/bin/env node
/**
 * Restore the app database from a backup file.
 *
 *   node scripts/restore.mjs <backup.db>
 *   # or via npm: npm run restore -- <backup.db>
 *
 * Stop the dashboard first (`docker stop` / systemctl stop) — SQLite
 * files must not be swapped under a running process. The current
 * database is kept as app.db.restore-bak so a bad restore is reversible.
 * Migrations run automatically at the next startup.
 */
import { copyFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

const backup = process.argv[2]?.trim();
if (!backup || !existsSync(backup)) {
	console.error('Usage: node scripts/restore.mjs <backup.db> — file must exist');
	process.exit(1);
}

// Sanity: must be a sqlite file we can open.
const probe = createClient({ url: `file:${path.resolve(backup)}` });
try {
	const { rows } = await probe.execute(
		"SELECT count(*) AS n FROM sqlite_master WHERE type='table'"
	);
	if (!rows[0]?.n) {
		console.error(`${backup} has no tables — not a valid backup.`);
		process.exit(1);
	}
} catch {
	console.error(`${backup} is not a readable SQLite database.`);
	process.exit(1);
} finally {
	probe.close();
}

const dataDir = process.env.DATA_DIR ?? './data';
const databaseUrl = process.env.DATABASE_URL ?? `file:${path.join(dataDir, 'app.db')}`;
if (!databaseUrl.startsWith('file:')) {
	console.error('Restore only works with a local file database (DATABASE_URL file:...).');
	process.exit(1);
}
const target = path.resolve(databaseUrl.slice('file:'.length));

if (existsSync(target)) {
	copyFileSync(target, `${target}.restore-bak`);
	console.log(`Existing database kept at ${target}.restore-bak`);
}
copyFileSync(path.resolve(backup), target);
console.log(
	`Restored ${path.resolve(backup)} (${statSync(target).size} bytes) → ${target}. Start the dashboard; migrations run at boot.`
);
