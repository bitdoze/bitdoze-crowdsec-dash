import path from 'node:path';
import { DATABASE_URL, DATA_DIR, MIGRATIONS_DIR, ORIGIN } from '$app/env/private';

// Under SvelteKit the schema defaults in src/env.ts fill these in; outside of it
// (e.g. the `auth` CLI evaluating auth.ts through jiti) they arrive as raw
// process.env values, so the defaults are repeated here.
const dataDir = DATA_DIR ?? './data';

export const config = {
	/** Public origin of the app; also the Better Auth baseURL. */
	origin: ORIGIN ?? 'http://localhost:5173',
	dataDir,
	/** Defaults to `file:${DATA_DIR}/app.db` when DATABASE_URL is unset. */
	databaseUrl: DATABASE_URL ?? `file:${path.join(dataDir, 'app.db')}`,
	migrationsDir: MIGRATIONS_DIR ?? './drizzle'
} as const;
