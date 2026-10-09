import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import {
	activityRollup,
	alert,
	alertSite,
	configArtifact,
	site
} from '#lib/server/db/app.schema.ts';
import { requirePermission, requireUser } from '#lib/server/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';
import { hasPermission } from '#lib/roles.ts';
import { probeSite } from '#lib/server/protect/detect.ts';
import { listArtifacts, markArtifact, regeneratePlan } from '#lib/server/protect/plan.ts';
import { CHECKS, listChecks, markTestWindow, runSiteChecks } from '#lib/server/protect/checks.ts';
import { TEST_PATH, driftHash } from '#lib/server/protect/templates.ts';
import {
	parseAliases,
	parseCollections,
	validateAliases,
	validateCollections
} from '#lib/sites.ts';
import { downsample } from '#lib/activity.ts';
import { agentHello, callAgent } from '#lib/server/agent/client.ts';
import { enqueue } from '#lib/server/jobs/queue.ts';
import { discoverTraefik, matchSite, parseDockerPs } from '#lib/server/protect/traefik.ts';

const PROXIES = ['caddy', 'traefik', 'nginx', 'other', 'unknown'] as const;
const RUNTIMES = ['native', 'docker', 'unknown'] as const;

async function loadSite(id: string) {
	const [s] = await db.select().from(site).where(eq(site.id, id)).limit(1);
	if (!s) error(404, 'Site not found.');
	return s;
}

export const load: PageServerLoad = async (event) => {
	const s = await loadSite(event.params.id);
	const [artifacts, checks, hello] = await Promise.all([
		listArtifacts(db, s.id),
		listChecks(db, s.id),
		agentHello()
	]);
	// Managed apply is offered only for complete-file artifacts that declare
	// a `# /path` target line — fragments stay guided because merging is a
	// per-host decision. Artifacts carrying a <bouncer-key> placeholder also
	// need the cscli bridge so the job can issue the key.
	const NEED_KEY = (a: { content: string }) => a.content.includes('<bouncer-key>');
	const MANAGED: Record<string, boolean> = {
		acquisition: !!hello?.caps.files,
		access_log: !!hello?.caps.files,
		appsec: !!hello?.caps.files,
		middleware: !!hello?.caps.files && !!hello?.caps.cscli,
		bouncer: !!hello?.caps.files && !!hello?.caps.cscli
	};
	const detection = s.detection ? (JSON.parse(s.detection) as Record<string, unknown>) : null;
	// Roots that count as proxy-config space — the fixed defaults plus this
	// site's stored confDir / Traefik dynamic dir.
	const proxyRoots = ['/etc/caddy/', '/etc/nginx/', '/etc/traefik/'];
	for (const d of [
		detection?.confDir,
		(detection?.docker as Record<string, unknown> | undefined)?.dynamicDir
	]) {
		if (typeof d === 'string' && /^\/\S{1,200}$/.test(d))
			proxyRoots.push(d.endsWith('/') ? d : `${d}/`);
	}
	// Site activity: recent attributed alerts + the hourly rollup over the
	// selected range, downsampled server-side to a bounded chart width
	// (spec §9: long-range downsampling). Level-4 WAF gating needs observed
	// CRS alerts (level 3 runs CRS out-of-band precisely to produce them).
	const ACT_RANGES = { '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000, '30d': 30 * 24 * 3600_000 };
	const rangeKey = (event.url.searchParams.get('actRange') ?? '7d') as keyof typeof ACT_RANGES;
	const actRange = ACT_RANGES[rangeKey] ? rangeKey : '7d';
	const [recent, rollup, crs] = await Promise.all([
		db
			.select({
				upstreamId: alert.upstreamId,
				scenario: alert.scenario,
				sourceIp: alert.sourceIp,
				startedAt: alert.startedAt
			})
			.from(alertSite)
			.innerJoin(alert, eq(alertSite.alertUpstreamId, alert.upstreamId))
			.where(eq(alertSite.siteId, s.id))
			.orderBy(desc(alert.startedAt))
			.limit(8),
		db
			.select({
				hour: activityRollup.hour,
				total: sql<number>`sum(${activityRollup.count})`
			})
			.from(activityRollup)
			.where(
				sql`${activityRollup.siteId} = ${s.id} AND ${activityRollup.hour} > ${Date.now() - ACT_RANGES[actRange]}`
			)
			.groupBy(activityRollup.hour)
			.orderBy(activityRollup.hour),
		db
			.select({ n: sql<number>`count(*)` })
			.from(alertSite)
			.innerJoin(alert, eq(alertSite.alertUpstreamId, alert.upstreamId))
			.where(sql`${alertSite.siteId} = ${s.id} AND ${alert.scenario} LIKE 'crowdsecurity/appsec-%'`)
	]);
	return {
		site: s,
		aliases: parseAliases(s.aliases),
		exclusions: parseCollections(s.appsecExclusions),
		detection,
		proxyRoots,
		crsAlerts: crs[0]?.n ?? 0,
		activity: {
			range: actRange,
			recent,
			buckets: downsample(
				rollup.map((r) => ({ at: r.hour.getTime(), total: r.total })),
				48
			)
		},
		artifacts: artifacts.map((a) => ({
			...a,
			target: a.content.match(/^# (\/\S+)$/m)?.[1] ?? null,
			needsKey: NEED_KEY(a),
			expectedHash: driftHash(a.content),
			managed: !!MANAGED[a.kind] && !!a.content.match(/^# (\/\S+)$/m)?.[1]
		})),
		agent: hello,
		dockerDiscovery: (detection?.docker ?? null) as Record<string, unknown> | null,
		checkDefs: CHECKS,
		checks: checks.map((c) => ({ ...c, evidence: c.evidence ? JSON.parse(c.evidence) : null })),
		testPath: TEST_PATH,
		canOperate: !!event.locals.user && hasPermission(event.locals.user.role, 'operate')
	};
};

const text = (f: FormData, name: string) => f.get(name)?.toString().trim() ?? '';

export const actions: Actions = {
	/** Update topology answers (proxy/runtime/cloudflare) and regenerate. */
	configure: async (event) => {
		requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const formData = await event.request.formData();
		const proxy = text(formData, 'proxy');
		const runtime = text(formData, 'runtime');
		await db
			.update(site)
			.set({
				proxy: (PROXIES as readonly string[]).includes(proxy)
					? (proxy as (typeof PROXIES)[number])
					: s.proxy,
				runtime: (RUNTIMES as readonly string[]).includes(runtime)
					? (runtime as (typeof RUNTIMES)[number])
					: s.runtime,
				cloudflare: formData.get('cloudflare') === 'on'
			})
			.where(eq(site.id, s.id));
		await regeneratePlan(db, s.id);
		await recordAudit({
			event,
			action: 'site.configured',
			detail: { hostname: s.hostname, proxy, runtime }
		});
		return { notice: 'Topology saved — artifacts regenerated.' };
	},

	/** Probe response headers (optionally a custom URL, e.g. an intranet vhost). */
	detect: async (event) => {
		requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const formData = await event.request.formData();
		const d = await probeSite(s.hostname, text(formData, 'probeUrl') || undefined);
		await db
			.update(site)
			.set({
				proxy: d.proxy === 'unknown' ? s.proxy : d.proxy,
				cloudflare: d.cloudflare || s.cloudflare,
				detection: JSON.stringify(d)
			})
			.where(eq(site.id, s.id));
		if (d.proxy !== 'unknown') await regeneratePlan(db, s.id);
		await recordAudit({
			event,
			action: 'site.detected',
			detail: { hostname: s.hostname, proxy: d.proxy, cloudflare: d.cloudflare }
		});
		if (d.error) return { notice: `Probe failed: ${d.error}` };
		return {
			notice: `Probed ${d.probedUrl} — proxy: ${d.proxy}, cloudflare: ${d.cloudflare ? 'yes' : 'no'}.`
		};
	},

	/** Mark an artifact applied (guided mode — the admin did it by hand). */
	artifactState: async (event) => {
		requirePermission(event, 'operate');
		const formData = await event.request.formData();
		const artifactId = text(formData, 'artifactId');
		const state = text(formData, 'state') === 'applied' ? 'applied' : 'not_applied';
		await markArtifact(db, artifactId, state);
		return { notice: state === 'applied' ? 'Marked applied.' : 'Marked not applied.' };
	},

	/** Open the test window, then the admin triggers the harmless test path. */
	markWindow: async (event) => {
		requireUser(event);
		const s = await loadSite(event.params.id);
		await markTestWindow(db, s.id);
		return { notice: `Test window opened — trigger the path below, then Run checks.` };
	},

	/** Run the automated checks for this site now. */
	runChecks: async (event) => {
		requireUser(event);
		const s = await loadSite(event.params.id);
		await runSiteChecks(db, s.id);
		return { notice: 'Checks re-run against the latest sync and metrics.' };
	},

	/** Manual confirmation for the real-IP check (guided, no automated probe). */
	confirmRealIp: async (event) => {
		requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const { protectionCheck } = await import('#lib/server/db/app.schema.ts');
		await db
			.insert(protectionCheck)
			.values({
				id: `${s.id}|real_ip`,
				siteId: s.id,
				checkId: 'real_ip',
				state: 'verified',
				evidence: JSON.stringify({ message: 'Confirmed manually by the administrator.' }),
				checkedAt: new Date(),
				updatedAt: new Date()
			})
			.onConflictDoUpdate({
				target: protectionCheck.id,
				set: {
					state: 'verified',
					evidence: JSON.stringify({ message: 'Confirmed manually by the administrator.' }),
					checkedAt: new Date(),
					updatedAt: new Date()
				}
			});
		return { notice: 'Real-IP check marked verified.' };
	},

	/** Tier D: install the plan's hub items through the agent as a job. */
	installCollections: async (event) => {
		const user = requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const hello = await agentHello(true);
		if (!hello?.caps.cscli) return { notice: 'Agent with a cscli bridge is not connected.' };
		const [collections] = (await listArtifacts(db, s.id)).filter((a) => a.kind === 'collections');
		if (!collections) return { notice: 'No collections artifact for this site.' };
		const items = [
			...collections.content.matchAll(
				/cscli (collections|parsers|scenarios|contexts|appsec-rules) install (\S+)/g
			)
		].map((m) => `${m[1]}:${m[2]}`);
		if (!items.length) return { notice: 'No installable items found in the artifact.' };
		const { created } = await enqueue(db, {
			kind: 'hub.install',
			params: { items },
			idempotencyKey: `hub.install:${collections.id}:${collections.contentHash}`,
			lockKey: 'hub',
			siteId: s.id,
			createdBy: user.id
		});
		await recordAudit({
			event,
			action: 'job.enqueued',
			detail: { kind: 'hub.install', hostname: s.hostname, items: items.length }
		});
		return {
			notice: created
				? `Queued install of ${items.length} hub items — watch System → Jobs.`
				: 'That install is already queued for this artifact version.'
		};
	},

	/**
	 * Tier D: managed apply of a complete-file artifact — backup → write →
	 * optional proxy validate → optional reload. Proxy-config artifacts
	 * require an adopted topology (explicit adoption, spec 8); CrowdSec-side
	 * files (acquisition, appsec, bouncer confs) stay unadopted-OK.
	 */
	applyArtifact: async (event) => {
		const user = requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const hello = await agentHello(true);
		if (!hello?.caps.files) return { notice: 'Agent file access is not configured.' };
		const formData = await event.request.formData();
		const artifactId = text(formData, 'artifactId');
		const reloadTarget = text(formData, 'reloadTarget');
		if (reloadTarget && !(hello.caps.services ?? []).includes(reloadTarget))
			return { notice: 'Reload target is not in the agent AGENT_SERVICES allowlist.' };
		const [a] = (await listArtifacts(db, s.id)).filter((x) => x.id === artifactId);
		const target = a?.content.match(/^# (\/\S+)$/m)?.[1];
		const MANAGED_KINDS = ['acquisition', 'middleware', 'bouncer', 'appsec', 'access_log'];
		if (!a || !MANAGED_KINDS.includes(a.kind) || !target)
			return { notice: 'Only complete-file artifacts with a declared target can be applied.' };
		// Writes into the proxy's own config space require explicit adoption —
		// CrowdSec-side files (acquis.d, appsec.yaml, bouncer confs) do not.
		// The roots are the fixed defaults plus the site's stored confDir and
		// Traefik dynamic dir (they live wherever the admin mapped them).
		const det = s.detection ? (JSON.parse(s.detection) as Record<string, unknown>) : {};
		const proxyRoots = ['/etc/caddy/', '/etc/nginx/', '/etc/traefik/'];
		for (const d of [
			det.confDir,
			(det.docker as Record<string, unknown> | undefined)?.dynamicDir
		]) {
			if (typeof d === 'string' && /^\/\S{1,200}$/.test(d))
				proxyRoots.push(d.endsWith('/') ? d : `${d}/`);
		}
		const touchesProxy = proxyRoots.some((r) => target.startsWith(r));
		const adopted = (det.adopted as { proxy?: string } | undefined)?.proxy;
		if (touchesProxy && adopted !== s.proxy)
			return {
				notice: `Adopt the ${s.proxy} topology first — managed writes into proxy config need explicit adoption.`
			};
		// Artifacts carrying a <bouncer-key> placeholder get a key issued via
		// cscli and substituted at write time — never persisted.
		const bouncerName = a.content.includes('<bouncer-key>')
			? `dash-${s.hostname.replace(/[^a-z0-9]/g, '-').slice(0, 40)}-${s.proxy}`
			: undefined;
		if (bouncerName && !hello.caps.cscli)
			return { notice: 'This artifact needs the agent cscli bridge to issue a bouncer key.' };
		// Proxy-config files validate through the proxy's own validator before
		// reload — same declared service target as the reload.
		const validateProxy =
			reloadTarget && touchesProxy && ['caddy', 'nginx'].includes(s.proxy)
				? (s.proxy as 'caddy' | 'nginx')
				: undefined;
		const { created, job: j } = await enqueue(db, {
			kind: 'config.apply',
			// artifactId lets the job mark the artifact applied only on success.
			params: {
				path: target,
				content: a.content,
				artifactId: a.id,
				bouncerName,
				reloadTarget: reloadTarget || undefined,
				validateTarget: reloadTarget || undefined,
				validateProxy
			},
			idempotencyKey: `apply:${a.id}:${a.contentHash}`,
			lockKey: `file:${target}`,
			siteId: s.id,
			createdBy: user.id
		});
		await recordAudit({
			event,
			action: 'job.enqueued',
			detail: { kind: 'config.apply', hostname: s.hostname, path: target, jobId: j.id }
		});
		return {
			notice: created
				? `Queued managed apply to ${target} — backup + write via the agent.`
				: 'That artifact version is already applied or queued.'
		};
	},

	/**
	 * Tier D: read the docker inventory through the agent and store the
	 * Traefik topology on this site (routers, published ports, plugin state).
	 */
	dockerDiscover: async (event) => {
		const user = requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const hello = await agentHello(true);
		if (!hello?.caps.docker)
			return {
				notice: 'Agent docker ops are not enabled — set AGENT_DOCKER=1 (or docker cscli mode).'
			};
		const r = await callAgent<{ output?: string }>('docker.ps', {});
		if (!r.ok) return { notice: `docker.ps failed: ${r.error.message}` };
		const d = discoverTraefik(parseDockerPs(r.result.output ?? ''));
		const match = matchSite(d, s.hostname);
		const formData = await event.request.formData();
		const dynamicDir = text(formData, 'dynamicDir');
		const prior = s.detection ? (JSON.parse(s.detection) as Record<string, unknown>) : {};
		await db
			.update(site)
			.set({
				detection: JSON.stringify({
					...prior,
					docker: {
						...d,
						dynamicDir: /^\/\S{1,200}$/.test(dynamicDir)
							? dynamicDir
							: ((prior.docker as Record<string, unknown> | undefined)?.dynamicDir ??
								'/etc/traefik/dynamic')
					}
				})
			})
			.where(eq(site.id, s.id));
		await recordAudit({
			event,
			action: 'site.discovered',
			detail: {
				hostname: s.hostname,
				via: 'docker',
				traefik: d.traefik?.container ?? null,
				apps: d.apps.length
			}
		});
		void user;
		return {
			notice: match
				? `Found ${match.container} routing ${s.hostname} via router "${match.router}".`
				: `Scanned ${d.apps.length} routed container(s) — none advertises ${s.hostname}.`
		};
	},

	/**
	 * Adopt the discovered topology: this site is routed by Traefik on Docker.
	 * Sets proxy/runtime and regenerates artifacts (with the stored dynamic dir).
	 */
	adoptTraefik: async (event) => {
		requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const prior = s.detection ? (JSON.parse(s.detection) as Record<string, unknown>) : {};
		const docker = prior.docker as Record<string, unknown> | undefined;
		if (!docker?.traefik) return { notice: 'Run Docker discovery first — no Traefik seen.' };
		const formData = await event.request.formData();
		const dynamicDir = text(formData, 'dynamicDir');
		const at = new Date().toISOString();
		await db
			.update(site)
			.set({
				proxy: 'traefik',
				runtime: 'docker',
				detection: JSON.stringify({
					...prior,
					adopted: { proxy: 'traefik', at },
					docker: {
						...docker,
						dynamicDir: /^\/\S{1,200}$/.test(dynamicDir)
							? dynamicDir
							: (docker.dynamicDir ?? '/etc/traefik/dynamic'),
						adoptedAt: at
					}
				})
			})
			.where(eq(site.id, s.id));
		await regeneratePlan(db, s.id);
		await recordAudit({
			event,
			action: 'site.adopted',
			detail: { hostname: s.hostname, proxy: 'traefik', runtime: 'docker', via: 'discover' }
		});
		return { notice: 'Adopted Traefik/Docker topology — artifacts regenerated.' };
	},

	/**
	 * Explicit adoption gate (spec 8) for Caddy/Nginx: marks the site's
	 * declared proxy as managed so artifacts writing into its config space
	 * (/etc/caddy, /etc/nginx) become eligible for managed apply.
	 */
	adoptProxy: async (event) => {
		requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		if (!['caddy', 'nginx'].includes(s.proxy))
			return {
				notice: 'Adoption applies to declared Caddy/Nginx sites (Traefik uses Docker adoption).'
			};
		const prior = s.detection ? (JSON.parse(s.detection) as Record<string, unknown>) : {};
		const formData = await event.request.formData();
		const confDir = text(formData, 'confDir');
		const at = new Date().toISOString();
		await db
			.update(site)
			.set({
				detection: JSON.stringify({
					...prior,
					adopted: { proxy: s.proxy, at },
					// Where managed proxy files live — nginx conf.d or the Caddy
					// snippet dir; only valid absolute-ish paths are stored.
					confDir: /^\/\S{1,200}$/.test(confDir)
						? confDir
						: ((prior.confDir as string | undefined) ??
							(s.proxy === 'caddy' ? '/etc/caddy/crowdsec' : '/etc/nginx/conf.d'))
				})
			})
			.where(eq(site.id, s.id));
		await regeneratePlan(db, s.id);
		await recordAudit({
			event,
			action: 'site.adopted',
			detail: { hostname: s.hostname, proxy: s.proxy, runtime: s.runtime, via: 'manual' }
		});
		return {
			notice: `Adopted ${s.proxy} — proxy-config artifacts can now be applied via the agent.`
		};
	},

	/**
	 * Site policy (spec 9): hostname aliases, WAF level, remediation preset.
	 * Level 4 (in-band CRS) is gated on observed level-3 CRS alerts — the
	 * observe-first flow needs evidence the site would have blocked before
	 * going blocking. Aliases are validated and must not collide with other
	 * sites' names (ambiguous attribution is worse than none).
	 */
	setPolicy: async (event) => {
		requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const formData = await event.request.formData();
		const waf = text(formData, 'wafLevel');
		const preset = text(formData, 'remediationPreset');
		const aliased = validateAliases(text(formData, 'aliases'), s.hostname);
		if ('error' in aliased) return { notice: aliased.error };
		// Alias collisions with other sites make attribution ambiguous — refuse.
		const others = await db
			.select({ id: site.id, hostname: site.hostname, aliases: site.aliases })
			.from(site)
			.where(sql`${site.id} != ${s.id}`);
		for (const o of others) {
			const names = new Set([o.hostname.toLowerCase(), ...parseAliases(o.aliases)]);
			for (const a of aliased.aliases) {
				if (names.has(a))
					return {
						notice: `"${a}" already names or aliases site ${o.hostname} — attribution would be ambiguous.`
					};
			}
		}
		const WAF = ['off', '1', '2', '3', '4'] as const;
		const wafLevel = (WAF as readonly string[]).includes(waf)
			? (waf as (typeof WAF)[number])
			: s.wafLevel;
		if (wafLevel === '4' && s.wafLevel !== '4') {
			// Level-4 gate: in-band CRS only after observed out-of-band alerts.
			const [{ n }] = await db
				.select({ n: sql<number>`count(*)` })
				.from(alertSite)
				.innerJoin(alert, eq(alertSite.alertUpstreamId, alert.upstreamId))
				.where(
					sql`${alertSite.siteId} = ${s.id} AND ${alert.scenario} LIKE 'crowdsecurity/appsec-%'`
				);
			if (!n)
				return {
					notice:
						'Level 4 blocks CRS matches in-band — run level 3 first so CRS alerts are observed. No CRS alerts seen for this site yet.'
				};
		}
		const PRESETS = ['flat', 'escalating', 'captcha'] as const;
		const remediationPreset = (PRESETS as readonly string[]).includes(preset)
			? (preset as (typeof PRESETS)[number])
			: s.remediationPreset;
		const exclusions = validateCollections(text(formData, 'exclusions'));
		if ('error' in exclusions) return { notice: exclusions.error };
		await db
			.update(site)
			.set({
				aliases: JSON.stringify(aliased.aliases),
				wafLevel,
				remediationPreset,
				appsecExclusions: JSON.stringify(exclusions.items)
			})
			.where(eq(site.id, s.id));
		await regeneratePlan(db, s.id);
		await recordAudit({
			event,
			action: 'site.configured',
			detail: {
				hostname: s.hostname,
				wafLevel,
				remediationPreset,
				aliases: aliased.aliases.length
			}
		});
		return { notice: 'Policy saved — artifacts regenerated.' };
	},

	/**
	 * Drift view (spec 9): read each complete-file artifact's declared target
	 * through the agent and hash-compare against the desired content. The
	 * bouncer-key line is normalized on both sides, so a substituted key is
	 * not drift. Observed-at is stamped even on unreadable targets.
	 */
	checkDrift: async (event) => {
		requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const hello = await agentHello(true);
		if (!hello?.caps.files) return { notice: 'Agent file access is not configured.' };
		const artifacts = await listArtifacts(db, s.id);
		const now = new Date();
		let checked = 0;
		let drifted = 0;
		for (const a of artifacts) {
			const target = a.content.match(/^# (\/\S+)$/m)?.[1];
			if (!target) continue;
			const r = await callAgent<{ content?: string }>('file.read', { path: target });
			if (r.ok && typeof r.result.content === 'string') {
				const observed = driftHash(r.result.content);
				if (observed !== driftHash(a.content)) drifted++;
				await db
					.update(configArtifact)
					.set({ observedHash: observed, observedAt: now })
					.where(eq(configArtifact.id, a.id));
			} else {
				// Unreadable/absent — record the observation with no hash.
				await db
					.update(configArtifact)
					.set({ observedHash: 'missing', observedAt: now })
					.where(eq(configArtifact.id, a.id));
			}
			checked++;
		}
		await recordAudit({
			event,
			action: 'site.drift_checked',
			detail: { hostname: s.hostname, checked, drifted }
		});
		return {
			notice: checked
				? `Observed ${checked} file(s): ${drifted ? `${drifted} drifted` : 'all in sync'}.`
				: 'No complete-file artifacts with declared targets to observe.'
		};
	}
};
