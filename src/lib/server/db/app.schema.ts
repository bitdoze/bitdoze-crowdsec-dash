import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth.schema.ts';

/**
 * Audit log of security-relevant actions (sign-in attempts, setup, 2FA
 * changes, user administration, session revocation). Append-only by
 * convention: nothing in the codebase updates or deletes rows, and the
 * lockout-recovery CLI leaves its own entry.
 */
export const audit = sqliteTable(
	'audit',
	{
		id: text('id').primaryKey(),
		at: integer('at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
		actorId: text('actor_id'),
		action: text('action').notNull(),
		detail: text('detail'),
		ip: text('ip')
	},
	(table) => [index('audit_at_idx').on(table.at), index('audit_userId_idx').on(table.userId)]
);

/**
 * The managed server — v1 monitors exactly one (id is always 'main').
 * The LAPI watcher password is stored encrypted (AES-GCM via the resolved
 * Better Auth secret), never in plaintext and never in page data.
 */
export const server = sqliteTable('server', {
	id: text('id').primaryKey(), // 'main'
	name: text('name').notNull(),
	lapiUrl: text('lapi_url'),
	metricsUrl: text('metrics_url'),
	machineId: text('machine_id'),
	/** symmetricEncrypt(secret, password); null when not connected */
	lapiPasswordEnc: text('lapi_password_enc'),
	/** Observer bouncer key (optional, tier B) — same treatment. */
	bouncerKeyEnc: text('bouncer_key_enc'),
	allowInsecureTls: integer('allow_insecure_tls', { mode: 'boolean' }).default(false).notNull(),
	crowdsecVersion: text('crowdsec_version'),
	connectedAt: integer('connected_at', { mode: 'timestamp_ms' })
});

/** A website known to the dashboard: entered manually or learned from alerts. */
export const site = sqliteTable('site', {
	id: text('id').primaryKey(),
	hostname: text('hostname').notNull().unique(),
	source: text('source', { enum: ['manual', 'learned'] }).notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull()
});

/**
 * Cached copy of a CrowdSec alert — a projection of upstream state. The
 * upstream numeric ID is the identity; nothing here is fabricated.
 * `events` keeps only per-event meta (the keys used for attribution), not the
 * raw event payload.
 */
export const alert = sqliteTable(
	'alert',
	{
		id: text('id').primaryKey(),
		upstreamId: integer('upstream_id').notNull().unique(),
		serverId: text('server_id').notNull().default('main'),
		machineId: text('machine_id'),
		scenario: text('scenario'),
		scenarioVersion: text('scenario_version'),
		message: text('message'),
		eventsCount: integer('events_count'),
		capacity: integer('capacity'),
		leakspeed: text('leakspeed'),
		simulated: integer('simulated', { mode: 'boolean' }).default(false).notNull(),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }),
		stoppedAt: integer('stopped_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }),
		sourceScope: text('source_scope'),
		sourceValue: text('source_value'),
		sourceIp: text('source_ip'),
		sourceCn: text('source_cn'),
		sourceAsName: text('source_as_name'),
		sourceAsNumber: text('source_as_number'),
		sourceLatitude: real('source_latitude'),
		sourceLongitude: real('source_longitude'),
		/** JSON: [{key, value}] alert context (target_fqdn lives here). */
		context: text('context'),
		/** JSON: [{key, value}] merged per-event meta (datasource_path etc.). */
		eventsMeta: text('events_meta'),
		syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [
		index('alert_startedAt_idx').on(table.startedAt),
		index('alert_sourceIp_idx').on(table.sourceIp),
		index('alert_scenario_idx').on(table.scenario)
	]
);

/** Alert ↔ site association with the signal that produced it. */
export const alertSite = sqliteTable(
	'alert_site',
	{
		alertUpstreamId: integer('alert_upstream_id').notNull(),
		siteId: text('site_id')
			.notNull()
			.references(() => site.id, { onDelete: 'cascade' }),
		/** context | event_meta | datasource — confidence order in spec 5.2. */
		signal: text('signal').notNull()
	},
	(table) => [index('alertSite_alert_idx').on(table.alertUpstreamId)]
);

/**
 * Projection of decisions seen on synced alerts. Replaced wholesale per
 * alert on re-sync, so removals reconcile. `expired` is reconciled by `until`.
 */
export const decision = sqliteTable(
	'decision',
	{
		id: text('id').primaryKey(),
		upstreamId: integer('upstream_id').notNull().unique(),
		alertUpstreamId: integer('alert_upstream_id'),
		serverId: text('server_id').notNull().default('main'),
		origin: text('origin'),
		type: text('type'),
		scope: text('scope'),
		value: text('value'),
		duration: text('duration'),
		scenario: text('scenario'),
		until: integer('until', { mode: 'timestamp_ms' }),
		expired: integer('expired', { mode: 'boolean' }).default(false).notNull(),
		syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [
		index('decision_value_idx').on(table.value),
		index('decision_until_idx').on(table.until)
	]
);

/**
 * Per-source sync cursor and health. `source` is 'alerts' | 'metrics'.
 * `partial` marks a bounded historical import still catching up.
 */
export const syncState = sqliteTable('sync_state', {
	source: text('source').primaryKey(),
	cursor: text('cursor'),
	lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
	lastError: text('last_error'),
	lastErrorAt: integer('last_error_at', { mode: 'timestamp_ms' }),
	partial: integer('partial', { mode: 'boolean' }).default(false).notNull()
});

/**
 * Whitelisted Prometheus counter samples (server capability + health tiers
 * only — no high-cardinality series). Raw samples are retained ~7 days.
 */
export const metricSample = sqliteTable(
	'metric_sample',
	{
		id: text('id').primaryKey(),
		at: integer('at', { mode: 'timestamp_ms' }).notNull(),
		name: text('name').notNull(),
		labels: text('labels'),
		value: real('value').notNull()
	},
	(table) => [index('metricSample_at_idx').on(table.at)]
);

/**
 * Hourly alert rollup maintained on ingest — charts never scan raw alerts.
 * `id` is a deterministic dedupe key (`hour|site|scenario|cn`) so upserts
 * don't need a unique index over nullable columns. siteId null =
 * unattributed; cn is the source country (ISO code).
 */
export const activityRollup = sqliteTable(
	'activity_rollup',
	{
		id: text('id').primaryKey(),
		hour: integer('hour', { mode: 'timestamp_ms' }).notNull(),
		siteId: text('site_id'),
		scenario: text('scenario'),
		cn: text('cn'),
		count: integer('count').notNull()
	},
	(table) => [
		index('activityRollup_hour_idx').on(table.hour),
		index('activityRollup_site_idx').on(table.siteId)
	]
);
