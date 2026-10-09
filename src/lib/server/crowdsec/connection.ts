/**
 * The CrowdSec connection record and helpers.
 *
 * The watcher password is stored encrypted with the resolved Better Auth
 * secret (`symmetricEncrypt`). Nothing here ever returns the plaintext
 * password — `buildClient` is the only place it is decrypted, in-memory.
 */
import { eq } from 'drizzle-orm';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { db } from '#lib/server/db/index.ts';
import { server } from '#lib/server/db/app.schema.ts';
import { resolveSecret } from '#lib/server/secrets.ts';
import { config } from '#lib/server/config.ts';
import { LapiClient } from './client.ts';

const encKey = () => resolveSecret('BETTER_AUTH_SECRET', { dataDir: config.dataDir });

export interface ServerRecord {
	id: string;
	name: string;
	lapiUrl: string | null;
	metricsUrl: string | null;
	machineId: string | null;
	allowInsecureTls: boolean;
	crowdsecVersion: string | null;
	connectedAt: Date | null;
	connected: boolean;
	hasBouncerKey: boolean;
}

export async function getServer(database: typeof db = db): Promise<ServerRecord> {
	const row = await database.select().from(server).where(eq(server.id, 'main')).get();
	if (!row) {
		return {
			id: 'main',
			name: 'server',
			lapiUrl: null,
			metricsUrl: null,
			machineId: null,
			allowInsecureTls: false,
			crowdsecVersion: null,
			connectedAt: null,
			connected: false,
			hasBouncerKey: false
		};
	}
	return {
		...row,
		connected: Boolean(row.lapiUrl && row.machineId && row.lapiPasswordEnc),
		hasBouncerKey: Boolean(row.bouncerKeyEnc)
	};
}

export async function saveConnection(
	database: typeof db,
	input: {
		name: string;
		lapiUrl: string;
		machineId: string;
		password: string;
		metricsUrl: string | null;
		bouncerKey: string | null;
		allowInsecureTls: boolean;
	}
) {
	const lapiPasswordEnc = await symmetricEncrypt({ key: encKey(), data: input.password });
	const bouncerKeyEnc = input.bouncerKey
		? await symmetricEncrypt({ key: encKey(), data: input.bouncerKey })
		: null;
	const values = {
		name: input.name,
		lapiUrl: input.lapiUrl,
		metricsUrl: input.metricsUrl,
		machineId: input.machineId,
		lapiPasswordEnc,
		bouncerKeyEnc,
		allowInsecureTls: input.allowInsecureTls,
		connectedAt: new Date()
	};
	await database
		.insert(server)
		.values({ id: 'main', ...values })
		.onConflictDoUpdate({ target: server.id, set: values });
}

export async function disconnect(database: typeof db) {
	await database
		.update(server)
		.set({
			lapiUrl: null,
			metricsUrl: null,
			machineId: null,
			lapiPasswordEnc: null,
			bouncerKeyEnc: null,
			connectedAt: null
		})
		.where(eq(server.id, 'main'));
}

/** Decrypt and build a ready client, or null when not connected. */
export async function buildClient(database: typeof db = db): Promise<LapiClient | null> {
	const row = await database.select().from(server).where(eq(server.id, 'main')).get();
	if (!row?.lapiUrl || !row.machineId || !row.lapiPasswordEnc) return null;
	const password = await symmetricDecrypt({ key: encKey(), data: row.lapiPasswordEnc });
	return new LapiClient({
		baseUrl: row.lapiUrl,
		machineId: row.machineId,
		password,
		insecureTls: row.allowInsecureTls
	});
}
