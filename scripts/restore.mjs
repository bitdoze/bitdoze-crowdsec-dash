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
import { copyFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
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
	// Fold any live WAL into the main file first — otherwise the
	// restore-bak silently loses the tail of recent commits.
	const fold = createClient({ url: databaseUrl });
	try {
		await fold.execute('PRAGMA busy_timeout = 5000');
		await fold.execute('PRAGMA wal_checkpoint(TRUNCATE)');
	} finally {
		fold.close();
	}
	// Atomic rename — NOT copyFileSync: truncating in place would leave
	// lazily-released handles (libsql close() defers) reading the new
	// content through the old inode. Renamed away, the old inode keeps its
	// identity and the bak file is a complete snapshot.
	renameSync(target, `${target}.restore-bak`);
	console.log(`Existing database kept at ${target}.restore-bak`);
}
// The stale WAL/SHM must go BEFORE the new file lands — otherwise SQLite
// replays frames from the old journal onto the restored image and
// post-backup writes resurrect (verified by scripts/drills.mjs).
rmSync(`${target}-wal`, { force: true });
rmSync(`${target}-shm`, { force: true });
copyFileSync(path.resolve(backup), target);
// VACUUM INTO produces a delete-mode journal; the app expects WAL. Switch
// now so the first-boot pragma is a no-op — the switch needs exclusive
// access and can race lazily-closing handles elsewhere (drills.mjs).
const warm = createClient({ url: databaseUrl });
try {
	for (let i = 0; ; i++) {
		try {
			const { rows } = await warm.execute('PRAGMA journal_mode = WAL');
			if (rows[0]?.journal_mode === 'wal') break;
			throw new Error(`journal_mode switch returned ${rows[0]?.journal_mode}`);
		} catch (e) {
			if (i >= 20 || !/busy/i.test(e instanceof Error ? e.message : String(e))) throw e;
			await new Promise((r) => setTimeout(r, 250));
		}
	}
} finally {
	warm.close();
}
console.log(
	`Restored ${path.resolve(backup)} (${statSync(target).size} bytes) → ${target}. Start the dashboard; migrations run at boot.`
);
