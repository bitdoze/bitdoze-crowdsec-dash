CREATE TABLE `app_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `notification` ADD `site` text;--> statement-breakpoint
ALTER TABLE `notification_channel` ADD `classes` text;--> statement-breakpoint
ALTER TABLE `notification_channel` ADD `site_ids` text;--> statement-breakpoint
ALTER TABLE `notification_channel` ADD `quiet_start` text;--> statement-breakpoint
ALTER TABLE `notification_channel` ADD `quiet_end` text;--> statement-breakpoint
ALTER TABLE `notification_channel` ADD `digest_minutes` integer DEFAULT 0 NOT NULL;