CREATE TABLE `saved_view` (
	`id` text PRIMARY KEY NOT NULL,
	`page` text NOT NULL,
	`name` text NOT NULL,
	`params` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `savedView_page_idx` ON `saved_view` (`page`);--> statement-breakpoint
ALTER TABLE `config_artifact` ADD `observed_hash` text;--> statement-breakpoint
ALTER TABLE `config_artifact` ADD `observed_at` integer;--> statement-breakpoint
ALTER TABLE `site` ADD `aliases` text;--> statement-breakpoint
ALTER TABLE `site` ADD `waf_level` text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE `site` ADD `remediation_preset` text DEFAULT 'escalating' NOT NULL;