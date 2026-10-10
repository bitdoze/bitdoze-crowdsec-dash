#!/usr/bin/env node
/**
 * Create a consistent database backup.
 *
 *   node scripts/backup.mjs [output-file]
 *   # or via npm: npm run backup
 *
 * Uses `VACUUM INTO`, safe against a running dashboard. Without an
 * argument the file lands in DATA_DIR/backups/app-<timestamp>.db — the
 * same directory the /system page lists.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

const dataDir = process.env.DATA_DIR ?? './data';
const databaseUrl = process.env.DATABASE_URL ?? `file:${path.join(dataDir, 'app.db')}`;
if (!databaseUrl.startsWith('file:')) {
	console.error('Backups only work with a local file database (DATABASE_URL file:...).');
	process.exit(1);
}

const out =
	process.argv[2]?.trim() ||
	path.join(dataDir, 'backups', `app-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

const client = createClient({ url: databaseUrl });
await client.execute(`VACUUM INTO '${path.resolve(out).replaceAll("'", "''")}'`);
console.log(`Backup written to ${path.resolve(out)}`);
