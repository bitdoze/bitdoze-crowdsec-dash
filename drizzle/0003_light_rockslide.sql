CREATE TABLE `decision_request` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`value` text NOT NULL,
	`type` text NOT NULL,
	`duration_s` integer NOT NULL,
	`reason` text,
	`state` text NOT NULL,
	`upstream_id` integer,
	`error` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `decisionRequest_value_idx` ON `decision_request` (`value`);--> statement-breakpoint
CREATE INDEX `decisionRequest_state_idx` ON `decision_request` (`state`);--> statement-breakpoint
CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`event_key` text NOT NULL UNIQUE,
	`class` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`href` text,
	`count` integer DEFAULT 1 NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	`last_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_eventKey_idx` ON `notification` (`event_key`);--> statement-breakpoint
CREATE INDEX `notification_lastAt_idx` ON `notification` (`last_at`);--> statement-breakpoint
CREATE TABLE `notification_channel` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`secret_enc` text,
	`enabled` integer DEFAULT true NOT NULL,
	`min_severity` text DEFAULT 'info' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_retry_at` integer,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`notification_id`) REFERENCES `notification`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channel`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `outbox_state_idx` ON `notification_outbox` (`state`,`next_retry_at`);--> statement-breakpoint
CREATE INDEX `outbox_notification_idx` ON `notification_outbox` (`notification_id`);