import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function kebab(name: string): string {
	return name.toLowerCase().replaceAll('_', '-');
}

/**
 * Resolves a secret in order of precedence:
 * 1. the `<NAME>` environment variable,
 * 2. the file referenced by `<NAME>_FILE`,
 * 3. a generated value persisted at `<dataDir>/secrets/<kebab-name>`
 *    (directory mode 0700, file mode 0600), created once and reused.
 *
 * Never log the returned value.
 */
export function resolveSecret(
	name: string,
	{ dataDir, env = process.env }: { dataDir: string; env?: NodeJS.ProcessEnv }
): string {
	const fromEnv = env[name];
	if (fromEnv) return fromEnv;

	const fileRef = env[`${name}_FILE`];
	if (fileRef) return readFileSync(fileRef, 'utf8').trim();

	const secretsDir = join(dataDir, 'secrets');
	const secretPath = join(secretsDir, kebab(name));
	try {
		return readFileSync(secretPath, 'utf8').trim();
	} catch {
		// first run: generate and persist
	}

	const generated = randomBytes(48).toString('base64url');
	mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
	chmodSync(secretsDir, 0o700);
	writeFileSync(secretPath, generated, { mode: 0o600 });
	chmodSync(secretPath, 0o600);
	return generated;
}
