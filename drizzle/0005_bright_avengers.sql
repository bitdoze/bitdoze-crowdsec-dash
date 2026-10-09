CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`params` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`idempotency_key` text,
	`lock_key` text,
	`site_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`leased_by` text,
	`result` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `site`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `job_state_idx` ON `job` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `job_lock_idx` ON `job` (`lock_key`,`state`);--> statement-breakpoint
CREATE INDEX `job_lease_idx` ON `job` (`lease_until`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_idempotency_idx` ON `job` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `job_step` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`idx` integer NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`detail` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `job`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_step_job_idx` ON `job_step` (`job_id`,`idx`);