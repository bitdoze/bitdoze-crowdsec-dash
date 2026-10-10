/**
 * Operational tooling: settings store, retention cleanup, disk-pressure
 * alerts, backups, support bundle, and the update check.
 *
 * Honesty rules applied throughout: nothing here fabricates state. The
 * bundle is redacted (no secretEnc columns, no tokens); backup works only
 * for local file databases; the update check reports fetch failures
 * rather than pretending everything is current.
 */
import { mkdirSync, readdirSync, statfsSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { db } from '#lib/server/db/index.ts';
import { rawClient } from '#lib/server/db/index.ts';
import {
	activityRollup,
	alert,
	alertSite,
	appSetting,
	audit,
	decision,
	decisionRequest,
	job,
	jobStep,
	metricSample,
	notification,
	notificationChannel,
	notificationOutbox,
	site,
	syncState
} from '#lib/server/db/app.schema.ts';
import { config } from '#lib/server/config.ts';
import { recordEvent } from '#lib/server/notify/core.ts';
import pkg from '../../../package.json' with { type: 'json' };

export const APP_VERSION = pkg.version;
const REPO = 'bitdoze/bitdoze-crowdsec-dash';

/* ---- settings ---- */

export async function getSetting(database: typeof db, key: string): Promise<string | null> {
	const row = await database
		.select({ value: appSetting.value })
		.from(appSetting)
		.where(eq(appSetting.key, key))
		.get();
	return row?.value ?? null;
}

export async function setSetting(database: typeof db, key: string, value: string): Promise<void> {
	await database
		.insert(appSetting)
		.values({ key, value, updatedAt: new Date() })
		.onConflictDoUpdate({ target: appSetting.key, set: { value, updatedAt: new Date() } });
}

async function getSettingJson<T>(database: typeof db, key: string): Promise<T | null> {
	const raw = await getSetting(database, key);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/* ---- retention ---- */

export interface RetentionPolicy {
	/** Days to keep each class of retained data. */
	notifications: number;
	jobs: number;
	audit: number;
	metrics: number;
	decisionRequests: number;
	/** Alert cache window (spec §8). */
	alerts: number;
	/** Hourly aggregate window (spec §8). */
	rollups: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
	notifications: 90,
	jobs: 30,
	audit: 365,
	metrics: 30,
	decisionRequests: 30,
	alerts: 30,
	rollups: 90
};

export async function getRetentionPolicy(database: typeof db): Promise<RetentionPolicy> {
	const saved = await getSettingJson<Partial<RetentionPolicy>>(database, 'retention');
	return { ...DEFAULT_RETENTION, ...(saved ?? {}) };
}

function cutoff(days: number): Date {
	return new Date(Date.now() - days * 86_400_000);
}

/** Delete rows older than the retention policy. Returns per-table counts. */
export async function runRetention(
	database: typeof db,
	policy?: RetentionPolicy
): Promise<Record<string, number>> {
	const p = policy ?? (await getRetentionPolicy(database));
	const counts: Record<string, number> = {};

	// Outbox rows cascade with their notification; deleting expired
	// notifications first leaves no orphans either way.
	await database
		.delete(notificationOutbox)
		.where(
			sql`${notificationOutbox.notificationId} in (select id from notification where last_at < ${cutoff(p.notifications)})`
		);
	const notifs = await database
		.delete(notification)
		.where(lt(notification.lastAt, cutoff(p.notifications)))
		.returning({ id: notification.id });
	counts.notifications = notifs.length;

	await database
		.delete(jobStep)
		.where(
			sql`${jobStep.jobId} in (select id from job where finished_at is not null and finished_at < ${cutoff(p.jobs)})`
		);
	const doneJobs = await database
		.delete(job)
		.where(sql`${job.finishedAt} IS NOT NULL AND ${job.finishedAt} < ${cutoff(p.jobs)}`)
		.returning({ id: job.id });
	counts.jobs = doneJobs.length;

	const audits = await database
		.delete(audit)
		.where(lt(audit.at, cutoff(p.audit)))
		.returning({ id: audit.id });
	counts.audit = audits.length;

	const metrics = await database
		.delete(metricSample)
		.where(lt(metricSample.at, cutoff(p.metrics)))
		.returning({ name: metricSample.name });
	counts.metricSamples = metrics.length;

	const reqs = await database
		.delete(decisionRequest)
		.where(lt(decisionRequest.createdAt, cutoff(p.decisionRequests)))
		.returning({ id: decisionRequest.id });
	counts.decisionRequests = reqs.length;

	// Alerts older than the cache window go only when every decision they
	// carry has expired — an active ban keeps its evidence. Site links and
	// the (expired-only) decision rows go with the alert.
	const staleAlerts = await database
		.select({ upstreamId: alert.upstreamId })
		.from(alert)
		.where(
			and(
				lt(alert.createdAt, cutoff(p.alerts)),
				sql`NOT EXISTS (
					SELECT 1 FROM decision
					WHERE decision.alert_upstream_id = ${alert.upstreamId}
					  AND decision.expired = 0
				)`
			)
		);
	const staleIds = staleAlerts.map((r) => r.upstreamId);
	counts.alerts = 0;
	// Chunked — a first prune on a busy server can exceed SQLite's bound-variable limit.
	for (let i = 0; i < staleIds.length; i += 500) {
		const chunk = staleIds.slice(i, i + 500);
		await database.delete(alertSite).where(inArray(alertSite.alertUpstreamId, chunk));
		await database.delete(decision).where(inArray(decision.alertUpstreamId, chunk));
		const gone = await database
			.delete(alert)
			.where(inArray(alert.upstreamId, chunk))
			.returning({ id: alert.id });
		counts.alerts += gone.length;
	}

	const rolls = await database
		.delete(activityRollup)
		.where(lt(activityRollup.hour, cutoff(p.rollups)))
		.returning({ id: activityRollup.id });
	counts.activityRollups = rolls.length;

	await setSetting(database, 'retention.lastRun', new Date().toISOString());
	return counts;
}

/* ---- disk pressure ---- */

export interface DiskState {
	path: string;
	freeBytes: number;
	totalBytes: number;
	freePct: number;
}

export function diskState(dir = config.dataDir): DiskState {
	const s = statfsSync(dir);
	const total = Number(s.blocks) * Number(s.bsize);
	const free = Number(s.bavail) * Number(s.bsize);
	return {
		path: dir,
		freeBytes: free,
		totalBytes: total,
		freePct: total ? (free / total) * 100 : 0
	};
}

/**
 * Threshold evaluation, separated from statfs so tests can drive any
 * freePct. `disk.low`/`disk.critical` dedupe while the condition persists
 * and clear with a recovery event when space returns.
 */
export async function evaluateDisk(database: typeof db, d: DiskState): Promise<void> {
	const lowKey = 'disk.low';
	const critKey = 'disk.critical';
	if (d.freePct < 5) {
		// Escalating: the warning marker is the same condition, so it clears.
		await database.delete(notification).where(eq(notification.eventKey, lowKey));
		await recordEvent(database, {
			eventKey: critKey,
			class: 'outage',
			severity: 'critical',
			title: 'Disk almost full',
			body: `${d.freePct.toFixed(1)}% free on ${d.path} — writes will start failing soon.`,
			href: '/system'
		});
	} else if (d.freePct < 15) {
		await recordEvent(database, {
			eventKey: lowKey,
			class: 'outage',
			severity: 'warning',
			title: 'Disk space low',
			body: `${d.freePct.toFixed(1)}% free on ${d.path}.`,
			href: '/system'
		});
	} else {
		for (const [key, title] of [
			[critKey, 'Disk pressure recovered'],
			[lowKey, 'Disk space recovered']
		] as const) {
			const existing = await database
				.select({ id: notification.id })
				.from(notification)
				.where(eq(notification.eventKey, key))
				.get();
			if (existing) {
				await database.delete(notification).where(eq(notification.id, existing.id));
				await recordEvent(database, {
					eventKey: `${key}.recovered.${Date.now()}`,
					class: 'outage',
					severity: 'info',
					title,
					body: `${d.freePct.toFixed(1)}% free on ${d.path}.`
				});
			}
		}
	}
}

export async function checkDiskPressure(
	database: typeof db,
	dir = config.dataDir
): Promise<DiskState> {
	const d = diskState(dir);
	await evaluateDisk(database, d);
	return d;
}

/* ---- backup ---- */

export function backupDir(): string {
	return path.join(config.dataDir, 'backups');
}

/**
 * Consistent snapshot via `VACUUM INTO` — safe against concurrent readers
 * and smaller than copying WAL files. Local file databases only; a remote
 * libSQL URL gets an honest error.
 */
export async function createBackup(): Promise<{ file: string; bytes: number }> {
	if (!config.databaseUrl.startsWith('file:'))
		throw new Error('Backups only work with a local file database (DATABASE_URL file:...).');
	const dir = backupDir();
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `app-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
	await rawClient.execute(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
	const { size } = statSync(file);
	pruneBackups(10);
	return { file, bytes: size };
}

export function listBackups(): { file: string; bytes: number; at: Date }[] {
	try {
		return readdirSync(backupDir())
			.filter((f) => f.endsWith('.db'))
			.map((f) => {
				const st = statSync(path.join(backupDir(), f));
				return { file: f, bytes: st.size, at: st.mtime };
			})
			.sort((a, b) => b.at.getTime() - a.at.getTime());
	} catch {
		return [];
	}
}

/** Keep the newest `keep` backups. */
export function pruneBackups(keep = 10): number {
	const files = listBackups();
	let removed = 0;
	for (const f of files.slice(keep)) {
		try {
			unlinkSync(path.join(backupDir(), f.file));
			removed++;
		} catch {
			// leave it — a failed unlink isn't worth losing the inventory
		}
	}
	return removed;
}

/* ---- support bundle ---- */

/**
 * Redacted diagnostic export. Every field is either a count, a version, or
 * a column chosen for containing no secrets — `secretEnc`/`tokenEnc` are
 * never read.
 */
export async function buildSupportBundle(database: typeof db): Promise<Record<string, unknown>> {
	const count = async (table: SQLiteTable): Promise<number> => {
		const r = await database
			.select({ n: sql<number>`count(*)` })
			.from(table)
			.get();
		return r?.n ?? 0;
	};
	const [syncRows, jobs, audits, sites, channels] = await Promise.all([
		database.select().from(syncState),
		database
			.select({
				kind: job.kind,
				state: job.state,
				attempts: job.attempts,
				createdAt: job.createdAt,
				finishedAt: job.finishedAt
			})
			.from(job)
			.orderBy(sql`${job.createdAt} desc`)
			.limit(50),
		database
			.select({ action: audit.action, at: audit.at })
			.from(audit)
			.orderBy(sql`${audit.at} desc`)
			.limit(200),
		database
			.select({ hostname: site.hostname, proxy: site.proxy, runtime: site.runtime })
			.from(site),
		database
			.select({
				name: notificationChannel.name,
				type: notificationChannel.type,
				enabled: notificationChannel.enabled
			})
			.from(notificationChannel)
	]);
	return {
		generatedAt: new Date().toISOString(),
		version: APP_VERSION,
		node: process.version,
		platform: `${process.platform}/${process.arch}`,
		uptimeSeconds: Math.round(process.uptime()),
		disk: diskState(),
		counts: {
			alerts: await count(alert),
			decisions: await count(decision),
			notifications: await count(notification),
			sites: sites.length,
			jobs: await count(job),
			audit: await count(audit)
		},
		syncState: syncRows,
		sites,
		channels,
		recentJobs: jobs,
		recentAudit: audits,
		updateCheck: await getSettingJson(database, 'updateCheck'),
		retention: await getRetentionPolicy(database)
	};
}

/* ---- update check ---- */

export interface UpdateCheck {
	checkedAt: string;
	latestTag: string | null;
	latestUrl: string | null;
	publishedAt: string | null;
	updateAvailable: boolean;
	error?: string;
}

/**
 * Ask GitHub for the latest release. Result is cached in app_setting so
 * /system renders instantly; failures are recorded, not hidden.
 */
export async function checkForUpdate(
	database: typeof db,
	fetchImpl: typeof fetch = fetch
): Promise<UpdateCheck> {
	const result: UpdateCheck = {
		checkedAt: new Date().toISOString(),
		latestTag: null,
		latestUrl: null,
		publishedAt: null,
		updateAvailable: false
	};
	try {
		const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
			headers: {
				accept: 'application/vnd.github+json',
				'user-agent': `crowdsec-dash/${APP_VERSION}`
			},
			signal: AbortSignal.timeout(10_000)
		});
		if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
		const rel = (await res.json()) as {
			tag_name?: string;
			html_url?: string;
			published_at?: string;
		};
		result.latestTag = rel.tag_name ?? null;
		result.latestUrl = rel.html_url ?? null;
		result.publishedAt = rel.published_at ?? null;
		result.updateAvailable = newerThanCurrent(result.latestTag);
	} catch (e) {
		result.error = e instanceof Error ? e.message : String(e);
	}
	await setSetting(database, 'updateCheck', JSON.stringify(result));
	return result;
}

/** Semver-ish compare: strips a leading v and compares numeric parts. */
export function newerThanCurrent(tag: string | null): boolean {
	if (!tag) return false;
	const parse = (v: string) =>
		v
			.replace(/^v/, '')
			.split('.')
			.map((p) => parseInt(p, 10) || 0);
	const [a, b] = [parse(tag), parse(APP_VERSION)];
	for (let i = 0; i < 3; i++) {
		if (a[i] > b[i]) return true;
		if (a[i] < b[i]) return false;
	}
	return false;
}
