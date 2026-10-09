import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSecret } from '../src/lib/server/secrets.ts';

const dirs: string[] = [];

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'secrets-test-'));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('resolveSecret', () => {
	it('prefers the environment variable', () => {
		expect(resolveSecret('MY_SECRET', { dataDir: tmp(), env: { MY_SECRET: 'from-env' } })).toBe(
			'from-env'
		);
	});

	it('reads the _FILE variant next', () => {
		const dir = tmp();
		const file = join(dir, 'secret.txt');
		writeFileSync(file, 'from-file\n');
		expect(resolveSecret('MY_SECRET', { dataDir: dir, env: { MY_SECRET_FILE: file } })).toBe(
			'from-file'
		);
	});

	it('generates, persists with mode 0600, and reuses the value', () => {
		const dir = tmp();
		const first = resolveSecret('MY_SECRET', { dataDir: dir, env: {} });
		const path = join(dir, 'secrets', 'my-secret');
		expect(readFileSync(path, 'utf8')).toBe(first);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, 'secrets')).mode & 0o777).toBe(0o700);
		// stable across calls
		expect(resolveSecret('MY_SECRET', { dataDir: dir, env: {} })).toBe(first);
	});
});
