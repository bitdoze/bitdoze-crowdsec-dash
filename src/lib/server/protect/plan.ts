/**
 * Turns a site row into persisted config artifacts. Regeneration replaces a
 * site's artifacts but preserves `applied`/`verified` state when the content
 * hash is unchanged — applying an artifact by hand is the administrator's
 * signal, not ours.
 */
import { and, eq } from 'drizzle-orm';
import type { db } from '#lib/server/db/index.ts';
import { configArtifact, server, site } from '#lib/server/db/app.schema.ts';
import { artifactHash, generatePlan, type PlanInput } from './templates.ts';

type Database = typeof db;

export function planInputFor(s: typeof site.$inferSelect, lapiUrl: string): PlanInput {
	// Site extras: docker discovery stores a host-side Traefik dynamic dir;
	// adoption stores the proxy's managed config dir (conf.d / snippets).
	let dynamicDir: string | undefined;
	let confDir: string | undefined;
	try {
		const det = s.detection ? (JSON.parse(s.detection) as Record<string, unknown>) : {};
		const v = (det.docker as Record<string, unknown> | undefined)?.dynamicDir;
		if (typeof v === 'string' && /^\/\S{1,200}$/.test(v)) dynamicDir = v;
		const cd = det.confDir;
		if (typeof cd === 'string' && /^\/\S{1,200}$/.test(cd)) confDir = cd;
	} catch {
		/* malformed detection JSON — ignore */
	}
	let appsecExclusions: string[] | undefined;
	try {
		const v = s.appsecExclusions ? (JSON.parse(s.appsecExclusions) as unknown) : [];
		if (Array.isArray(v)) appsecExclusions = v.filter((x): x is string => typeof x === 'string');
	} catch {
		/* malformed JSON — treat as none */
	}
	return {
		hostname: s.hostname,
		proxy: s.proxy,
		runtime: s.runtime,
		cloudflare: s.cloudflare,
		lapiUrl,
		logDir: '/var/log/proxy', // documented default; admins adjust paths
		dynamicDir,
		confDir,
		wafLevel: s.wafLevel,
		remediationPreset: s.remediationPreset,
		appsecExclusions
	};
}

/** (Re)generate and persist the artifact set for a site. */
export async function regeneratePlan(database: Database, siteId: string): Promise<number> {
	const [s] = await database.select().from(site).where(eq(site.id, siteId)).limit(1);
	if (!s) return 0;
	const [srv] = await database.select().from(server).where(eq(server.id, 'main')).limit(1);
	const input = planInputFor(s, srv?.lapiUrl ?? 'http://crowdsec:8080');
	const artifacts = generatePlan(input);
	const now = new Date();
	const existing = await database
		.select()
		.from(configArtifact)
		.where(eq(configArtifact.siteId, siteId));
	for (const a of artifacts) {
		const id = `${siteId}|${a.kind}`;
		const hash = artifactHash(a.content);
		const prev = existing.find((e) => e.id === id);
		// Content changed → back to not_applied; unchanged → keep the state.
		const state = prev && prev.contentHash === hash ? prev.state : 'not_applied';
		await database
			.insert(configArtifact)
			.values({
				id,
				siteId,
				kind: a.kind,
				title: a.title,
				format: a.format,
				content: a.content,
				contentHash: hash,
				state,
				createdAt: prev?.createdAt ?? now,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: configArtifact.id,
				set: {
					title: a.title,
					format: a.format,
					content: a.content,
					contentHash: hash,
					state,
					updatedAt: now
				}
			});
	}
	// Drop artifacts for kinds no longer generated (proxy changed).
	const keep = new Set(artifacts.map((a) => `${siteId}|${a.kind}`));
	for (const e of existing) {
		if (!keep.has(e.id)) await database.delete(configArtifact).where(eq(configArtifact.id, e.id));
	}
	return artifacts.length;
}

export async function listArtifacts(database: Database, siteId: string) {
	return database
		.select()
		.from(configArtifact)
		.where(eq(configArtifact.siteId, siteId))
		.orderBy(configArtifact.kind);
}

export async function markArtifact(
	database: Database,
	artifactId: string,
	state: 'applied' | 'not_applied'
) {
	await database
		.update(configArtifact)
		.set({ state, updatedAt: new Date() })
		.where(and(eq(configArtifact.id, artifactId)));
}
