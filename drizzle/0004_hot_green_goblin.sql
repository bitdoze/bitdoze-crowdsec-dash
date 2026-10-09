CREATE TABLE `config_artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`format` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`state` text DEFAULT 'not_applied' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `site`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `configArtifact_site_idx` ON `config_artifact` (`site_id`);--> statement-breakpoint
CREATE TABLE `protection_check` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`check_id` text NOT NULL,
	`state` text DEFAULT 'not_run' NOT NULL,
	`evidence` text,
	`marked_at` integer,
	`checked_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `site`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `protectionCheck_site_idx` ON `protection_check` (`site_id`);--> statement-breakpoint
ALTER TABLE `site` ADD `proxy` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `site` ADD `runtime` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `site` ADD `cloudflare` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `site` ADD `detection` text;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_event_key_unique` ON `notification` (`event_key`);