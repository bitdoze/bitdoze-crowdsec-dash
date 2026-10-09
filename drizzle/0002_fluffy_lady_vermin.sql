CREATE TABLE `activity_rollup` (
	`id` text PRIMARY KEY NOT NULL,
	`hour` integer NOT NULL,
	`site_id` text,
	`scenario` text,
	`cn` text,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activityRollup_hour_idx` ON `activity_rollup` (`hour`);--> statement-breakpoint
CREATE INDEX `activityRollup_site_idx` ON `activity_rollup` (`site_id`);--> statement-breakpoint
CREATE TABLE `alert` (
	`id` text PRIMARY KEY NOT NULL,
	`upstream_id` integer NOT NULL,
	`server_id` text DEFAULT 'main' NOT NULL,
	`machine_id` text,
	`scenario` text,
	`scenario_version` text,
	`message` text,
	`events_count` integer,
	`capacity` integer,
	`leakspeed` text,
	`simulated` integer DEFAULT false NOT NULL,
	`started_at` integer,
	`stopped_at` integer,
	`created_at` integer,
	`source_scope` text,
	`source_value` text,
	`source_ip` text,
	`source_cn` text,
	`source_as_name` text,
	`source_as_number` text,
	`source_latitude` real,
	`source_longitude` real,
	`context` text,
	`events_meta` text,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_upstream_id_unique` ON `alert` (`upstream_id`);--> statement-breakpoint
CREATE INDEX `alert_startedAt_idx` ON `alert` (`started_at`);--> statement-breakpoint
CREATE INDEX `alert_sourceIp_idx` ON `alert` (`source_ip`);--> statement-breakpoint
CREATE INDEX `alert_scenario_idx` ON `alert` (`scenario`);--> statement-breakpoint
CREATE TABLE `alert_site` (
	`alert_upstream_id` integer NOT NULL,
	`site_id` text NOT NULL,
	`signal` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `site`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alertSite_alert_idx` ON `alert_site` (`alert_upstream_id`);--> statement-breakpoint
CREATE TABLE `decision` (
	`id` text PRIMARY KEY NOT NULL,
	`upstream_id` integer NOT NULL,
	`alert_upstream_id` integer,
	`server_id` text DEFAULT 'main' NOT NULL,
	`origin` text,
	`type` text,
	`scope` text,
	`value` text,
	`duration` text,
	`scenario` text,
	`until` integer,
	`expired` integer DEFAULT false NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decision_upstream_id_unique` ON `decision` (`upstream_id`);--> statement-breakpoint
CREATE INDEX `decision_value_idx` ON `decision` (`value`);--> statement-breakpoint
CREATE INDEX `decision_until_idx` ON `decision` (`until`);--> statement-breakpoint
CREATE TABLE `metric_sample` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`name` text NOT NULL,
	`labels` text,
	`value` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `metricSample_at_idx` ON `metric_sample` (`at`);--> statement-breakpoint
CREATE TABLE `server` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`lapi_url` text,
	`metrics_url` text,
	`machine_id` text,
	`lapi_password_enc` text,
	`bouncer_key_enc` text,
	`allow_insecure_tls` integer DEFAULT false NOT NULL,
	`crowdsec_version` text,
	`connected_at` integer
);
--> statement-breakpoint
CREATE TABLE `site` (
	`id` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_hostname_unique` ON `site` (`hostname`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`source` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`last_success_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`partial` integer DEFAULT false NOT NULL
);
