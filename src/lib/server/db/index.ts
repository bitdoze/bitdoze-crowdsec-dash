import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from './schema.ts';
import { config } from '../config.ts';

mkdirSync(config.dataDir, { recursive: true });

// If DATABASE_URL points to a local file outside DATA_DIR, make sure its parent exists.
if (config.databaseUrl.startsWith('file:')) {
	const filePath = config.databaseUrl.slice('file:'.length);
	if (filePath && !filePath.startsWith(':memory')) {
		mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
	}
}

const client = createClient({ url: config.databaseUrl });

export const db = drizzle(client, { schema });

export async function migrateDatabase(): Promise<void> {
	await client.executeMultiple(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 5000;
		PRAGMA foreign_keys = ON;
	`);
	await migrate(db, { migrationsFolder: path.resolve(process.cwd(), config.migrationsDir) });
}
