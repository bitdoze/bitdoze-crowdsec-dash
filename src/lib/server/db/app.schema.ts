import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
	/** Fronting proxy — detected from headers or set by the administrator. */
	proxy: text('proxy', { enum: ['caddy', 'traefik', 'nginx', 'other', 'unknown'] })
		.default('unknown')
		.notNull(),
	/** Where the proxy runs — the artifact generator keys off this. */
	runtime: text('runtime', { enum: ['native', 'docker', 'unknown'] })
		.default('unknown')
		.notNull(),
	/** Cloudflare sits in front (detected via cf-ray/cf-cache headers or set). */
	cloudflare: integer('cloudflare', { mode: 'boolean' }).default(false).notNull(),
	/** JSON array of alternate hostnames that attribute alerts to this site. */
	aliases: text('aliases'),
	/** WAF protection level 1–4 (spec 5.5); 'off' disables AppSec artifacts. */
	wafLevel: text('waf_level', { enum: ['off', '1', '2', '3', '4'] })
		.default('1')
		.notNull(),
	/** Remediation profile preset (spec 5.7): flat | escalating | captcha. */
	remediationPreset: text('remediation_preset', {
		enum: ['flat', 'escalating', 'captcha']
	})
		.default('escalating')
		.notNull(),
	/** JSON array of per-site AppSec exclusion collection names (spec 5.5). */
	appsecExclusions: text('appsec_exclusions'),
	/** JSON evidence from the last topology probe: {headers, probedUrl, at}. */
	detection: text('detection'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull()
});

/**
 * A generated configuration artifact for a site's protection plan. Guided
 * mode: the dashboard never applies these itself — the administrator copies
 * them, then marks them applied. `contentHash` lets a later regeneration
 * show whether the artifact drifted.
 */
export const configArtifact = sqliteTable(
	'config_artifact',
	{
		id: text('id').primaryKey(),
		siteId: text('site_id')
			.notNull()
			.references(() => site.id, { onDelete: 'cascade' }),
		kind: text('kind', {
			enum: [
				'access_log',
				'acquisition',
				'collections',
				'real_ip',
				'bouncer',
				'middleware',
				'appsec',
				'remediation',
				'compose',
				'demo'
			]
		}).notNull(),
		title: text('title').notNull(),
		/** Syntax hint for the code block: yaml | caddyfile | nginx | toml | shell | compose. */
		format: text('format').notNull(),
		content: text('content').notNull(),
		contentHash: text('content_hash').notNull(),
		/** not_applied until the admin confirms; verified when a check passes. */
		state: text('state', { enum: ['not_applied', 'applied', 'verified'] })
			.default('not_applied')
			.notNull(),
		/** sha256 of the target file as last read by the agent (drift view). */
		observedHash: text('observed_hash'),
		observedAt: integer('observed_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [index('configArtifact_site_idx').on(table.siteId)]
);

/**
 * Latest result of a per-site protection verification check (spec 5.6).
 * `markedAt` starts a test window: the admin triggers CrowdSec's own
 * harmless test path and the check looks for the resulting alert.
 */
export const protectionCheck = sqliteTable(
	'protection_check',
	{
		/** Deterministic: `${siteId}|${checkId}`. */
		id: text('id').primaryKey(),
		siteId: text('site_id')
			.notNull()
			.references(() => site.id, { onDelete: 'cascade' }),
		checkId: text('check_id').notNull(), // acquisition | test_alert | decision_feed | waf | real_ip
		state: text('state', {
			enum: ['not_run', 'verified', 'failed', 'stale', 'not_applicable']
		})
			.default('not_run')
			.notNull(),
		/** JSON evidence shown under the check: counters, alert ids, guidance. */
		evidence: text('evidence'),
		markedAt: integer('marked_at', { mode: 'timestamp_ms' }),
		checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [index('protectionCheck_site_idx').on(table.siteId)]
);

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
		index('decision_until_idx').on(table.until),
		// Edge sync scans (expired=0 AND origin IN local-origins) — bench
		// showed ~82ms/scan at 10k rows without it.
		index('decision_edge_idx').on(table.expired, table.origin)
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

/**
 * A manual decision the dashboard pushed (or asked the operator to push)
 * upstream. Tracks requested → confirmed lifecycle: `pushed` once the
 * LAPI accepted it, `confirmed` when the synced projection shows the
 * decision active, `removed` after unban reconciles.
 */
export const decisionRequest = sqliteTable(
	'decision_request',
	{
		id: text('id').primaryKey(),
		scope: text('scope', { enum: ['ip', 'range'] }).notNull(),
		value: text('value').notNull(),
		type: text('type', { enum: ['ban', 'captcha'] }).notNull(),
		durationS: integer('duration_s').notNull(),
		reason: text('reason'),
		state: text('state', {
			enum: ['pushed', 'confirmed', 'failed', 'removing', 'removed']
		}).notNull(),
		/** LAPI decision id once observed in the projection. */
		upstreamId: integer('upstream_id'),
		error: text('error'),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [
		index('decisionRequest_value_idx').on(table.value),
		index('decisionRequest_state_idx').on(table.state)
	]
);

/**
 * Persistent inbox row — one per event worth surfacing. `eventKey`
 * dedupes recurring events (e.g. repeated outage) so the inbox shows one
 * row with a bumped `lastAt`/`count` instead of a stream.
 */
export const notification = sqliteTable(
	'notification',
	{
		id: text('id').primaryKey(),
		eventKey: text('event_key').notNull().unique(),
		class: text('class').notNull(), // outage | security | admin | job
		severity: text('severity', { enum: ['info', 'warning', 'critical'] }).notNull(),
		title: text('title').notNull(),
		body: text('body'),
		href: text('href'),
		/** Site id when the event is site-scoped; null = system-wide. */
		site: text('site'),
		count: integer('count').default(1).notNull(),
		readAt: integer('read_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		lastAt: integer('last_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [
		index('notification_eventKey_idx').on(table.eventKey),
		index('notification_lastAt_idx').on(table.lastAt)
	]
);

/** Delivery channel — type determines which config keys apply (JSON). */
export const notificationChannel = sqliteTable('notification_channel', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	type: text('type', {
		enum: ['smtp', 'webhook', 'ntfy', 'gotify', 'discord', 'slack', 'telegram']
	}).notNull(),
	/** JSON config; secrets stored inside `secretEnc` only. */
	config: text('config').notNull(),
	/** symmetricEncrypt'd JSON of secrets (tokens, passwords, webhook URLs). */
	secretEnc: text('secret_enc'),
	enabled: integer('enabled', { mode: 'boolean' }).default(true).notNull(),
	/** Minimum severity delivered to this channel. */
	minSeverity: text('min_severity', { enum: ['info', 'warning', 'critical'] })
		.default('info')
		.notNull(),
	/** JSON array of NotifyClass values to deliver; null = all classes. */
	classes: text('classes'),
	/** JSON array of site ids to deliver; null = all. Site-less (system) events always pass. */
	siteIds: text('site_ids'),
	/** Quiet hours in UTC (HH:MM). Both set = active window; critical events bypass. */
	quietStart: text('quiet_start'),
	quietEnd: text('quiet_end'),
	/** >0 = batch deliveries into one digest every N minutes. */
	digestMinutes: integer('digest_minutes').default(0).notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull()
});

/**
 * Transactional outbox — one row per notification × channel delivery.
 * The worker drains pending rows with bounded backoff; `failed` rows keep
 * the last error and can be retried manually.
 */
export const notificationOutbox = sqliteTable(
	'notification_outbox',
	{
		id: text('id').primaryKey(),
		notificationId: text('notification_id')
			.notNull()
			.references(() => notification.id, { onDelete: 'cascade' }),
		channelId: text('channel_id')
			.notNull()
			.references(() => notificationChannel.id, { onDelete: 'cascade' }),
		state: text('state', { enum: ['pending', 'delivered', 'failed'] }).notNull(),
		attempts: integer('attempts').default(0).notNull(),
		lastError: text('last_error'),
		nextRetryAt: integer('next_retry_at', { mode: 'timestamp_ms' }),
		deliveredAt: integer('delivered_at', { mode: 'timestamp_ms' }),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [
		index('outbox_state_idx').on(table.state, table.nextRetryAt),
		index('outbox_notification_idx').on(table.notificationId)
	]
);

/**
 * Durable job — a queued unit of privileged work (agent ops, managed
 * config applies). States per spec §10. `lockKey` serializes jobs on the
 * same resource; `idempotencyKey` dedupes submissions; `lease*` reclaims
 * work abandoned by a crashed worker.
 */
export const job = sqliteTable(
	'job',
	{
		id: text('id').primaryKey(),
		kind: text('kind').notNull(), // runner registry key — see jobs/runners.ts
		params: text('params').notNull(), // JSON, validated by the runner before use
		state: text('state', {
			enum: [
				'queued',
				'running',
				'succeeded',
				'failed',
				'cancel_requested',
				'cancelled',
				'rollback_running',
				'rollback_failed'
			]
		})
			.default('queued')
			.notNull(),
		/** Unique submission key — re-submitting returns the existing row. */
		idempotencyKey: text('idempotency_key'),
		/** Resource lock: only one active job may hold a given key. */
		lockKey: text('lock_key'),
		siteId: text('site_id').references(() => site.id, { onDelete: 'set null' }),
		attempts: integer('attempts').default(0).notNull(),
		leaseUntil: integer('lease_until', { mode: 'timestamp_ms' }),
		leasedBy: text('leased_by'),
		/** Redacted outcome summary or error. */
		result: text('result'),
		createdBy: text('created_by'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' })
	},
	(table) => [
		index('job_state_idx').on(table.state, table.createdAt),
		index('job_lock_idx').on(table.lockKey, table.state),
		index('job_lease_idx').on(table.leaseUntil),
		uniqueIndex('job_idempotency_idx').on(table.idempotencyKey)
	]
);

/** One row per recorded step — step outcomes make retries resumable. */
export const jobStep = sqliteTable(
	'job_step',
	{
		id: text('id').primaryKey(),
		jobId: text('job_id')
			.notNull()
			.references(() => job.id, { onDelete: 'cascade' }),
		idx: integer('idx').notNull(),
		name: text('name').notNull(),
		state: text('state', {
			enum: ['pending', 'running', 'succeeded', 'failed', 'skipped']
		}).notNull(),
		/** Redacted evidence — bounded size, secrets scrubbed. */
		detail: text('detail'),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' })
	},
	(table) => [index('job_step_job_idx').on(table.jobId, table.idx)]
);

/**
 * A saved investigation view (spec 9 — saved searches): a named set of
 * list-page filter params an operator can re-apply from a chip row.
 */
export const savedView = sqliteTable(
	'saved_view',
	{
		id: text('id').primaryKey(),
		/** Which list page the params apply to: alerts | decisions. */
		page: text('page', { enum: ['alerts', 'decisions'] }).notNull(),
		name: text('name').notNull(),
		/** JSON-encoded URLSearchParams-like record of filter → value. */
		params: text('params').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [index('savedView_page_idx').on(table.page)]
);

/**
 * A connected Cloudflare account (spec §6.3). One row per admin-added
 * token; the token itself lives only in `tokenEnc` (symmetricEncrypt'd).
 * The account-level IP list is one-per-account, so its state is stored
 * here; per-zone state lives in `cloudflare_zone`.
 */
export const cloudflareAccount = sqliteTable('cloudflare_account', {
	id: text('id').primaryKey(),
	/** Operator label, e.g. "personal". */
	name: text('name').notNull(),
	/** CF account id — learned from zone discovery; '' until known. */
	cfAccountId: text('cf_account_id').notNull().default(''),
	tokenEnc: text('token_enc').notNull(),
	/** Last verify() outcome: active | disabled | expired | error. */
	tokenStatus: text('token_status'),
	/** JSON array of permission-group names from the last verify. */
	permissions: text('permissions'),
	verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
	lastError: text('last_error'),
	/** Managed/adopted account-level IP list. */
	listId: text('list_id'),
	listName: text('list_name'),
	/** true = we created it (uninstall may delete); false = adopted. */
	listOwned: integer('list_owned', { mode: 'boolean' }).default(false).notNull(),
	listItemCount: integer('list_item_count'),
	/** Decisions dropped on the last sync for capacity. */
	listDropped: integer('list_dropped').default(0).notNull(),
	lastSyncAt: integer('last_sync_at', { mode: 'timestamp_ms' }),
	lastSyncState: text('last_sync_state', { enum: ['ok', 'degraded', 'failed'] }),
	lastSyncError: text('last_sync_error'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull()
});

/**
 * A Cloudflare zone under a connected account. The dashboard only
 * touches zones the operator explicitly selects; `ruleId` records the
 * managed WAF custom rule this installation owns.
 */
export const cloudflareZone = sqliteTable(
	'cloudflare_zone',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id')
			.notNull()
			.references(() => cloudflareAccount.id, { onDelete: 'cascade' }),
		zoneId: text('zone_id').notNull(),
		name: text('name').notNull(),
		plan: text('plan'),
		/** Operator opted this zone into edge enforcement. */
		selected: integer('selected', { mode: 'boolean' }).default(false).notNull(),
		/** JSON array; empty = whole zone. */
		hostnames: text('hostnames').notNull().default('[]'),
		/** JSON array of URI path prefixes ("/admin"); empty = all paths. */
		paths: text('paths').notNull().default('[]'),
		action: text('action', { enum: ['block', 'challenge', 'log'] })
			.default('block')
			.notNull(),
		/** The managed rule's id inside the zone's custom-rules ruleset. */
		ruleId: text('rule_id'),
		/** Custom rules observed in use (Free plan allows 5/zone). */
		rulesInUse: integer('rules_in_use'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull()
	},
	(table) => [index('cfZone_account_idx').on(table.accountId)]
);

/**
 * Per-user API keys for the agent/machine surface (`/api/v1/*` and `/mcp`).
 * The raw key is shown once at creation; only its sha256 is stored. `scope`
 * caps what the key may do — the effective permission is also bounded by the
 * owner's role, so demoting a user weakens their keys automatically.
 */
export const apiKey = sqliteTable(
	'api_key',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		/** `csd_` + first 8 secret chars — display only, not enough to auth. */
		prefix: text('prefix').notNull(),
		keyHash: text('key_hash').notNull().unique(),
		scope: text('scope', { enum: ['read', 'operate'] })
			.notNull()
			.default('read'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
		revokedAt: integer('revoked_at', { mode: 'timestamp_ms' })
	},
	(table) => [index('apiKey_user_idx').on(table.userId)]
);

/** Durable key/value app settings — retention policy, update-check cache. */
export const appSetting = sqliteTable('app_setting', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});
