CREATE TABLE `cloudflare_account` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cf_account_id` text DEFAULT '' NOT NULL,
	`token_enc` text NOT NULL,
	`token_status` text,
	`permissions` text,
	`verified_at` integer,
	`last_error` text,
	`list_id` text,
	`list_name` text,
	`list_owned` integer DEFAULT false NOT NULL,
	`list_item_count` integer,
	`list_dropped` integer DEFAULT 0 NOT NULL,
	`last_sync_at` integer,
	`last_sync_state` text,
	`last_sync_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloudflare_zone` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`name` text NOT NULL,
	`plan` text,
	`selected` integer DEFAULT false NOT NULL,
	`hostnames` text DEFAULT '[]' NOT NULL,
	`action` text DEFAULT 'block' NOT NULL,
	`rule_id` text,
	`rules_in_use` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `cloudflare_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cfZone_account_idx` ON `cloudflare_zone` (`account_id`);