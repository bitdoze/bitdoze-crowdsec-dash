/**
 * Vitest stub for `$app/env/private` — vitest doesn't run the SvelteKit
 * plugin, so modules that import it (config.ts) resolve here instead.
 * Sets a hermetic DATA_DIR before config.ts evaluates it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'csdash-test-'));
process.env.BETTER_AUTH_SECRET ??= 'test-secret-not-for-production';

export const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';
export const DATA_DIR = process.env.DATA_DIR;
export const DATABASE_URL = process.env.DATABASE_URL;
export const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;
export const SETUP_TOKEN = process.env.SETUP_TOKEN;
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR;
export const DEMO_FIXTURES = process.env.DEMO_FIXTURES;
export const TRUSTED_PROXIES = process.env.TRUSTED_PROXIES;

// Agent tests bind a real unix socket under a per-worker tmp dir.
const agentDir = mkdtempSync(join(tmpdir(), 'csdash-agent-'));
process.env.AGENT_SOCKET ??= join(agentDir, 'agent.sock');
process.env.AGENT_TOKEN ??= 'test-agent-token';
export const AGENT_DIR = agentDir;
export const AGENT_SOCKET = process.env.AGENT_SOCKET;
export const AGENT_TOKEN = process.env.AGENT_TOKEN;
