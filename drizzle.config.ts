import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL ?? `file:${process.env.DATA_DIR ?? './data'}/app.db`;

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: { url: databaseUrl },
	verbose: true,
	strict: true
});
