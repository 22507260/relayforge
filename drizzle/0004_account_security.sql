CREATE TABLE `security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `security_events_owner_idx` ON `security_events` (`owner`,`created_at`);--> statement-breakpoint
CREATE TABLE `security_rate_limits` (
	`owner` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`attempts` integer NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `public_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_seen_at` integer;--> statement-breakpoint
UPDATE `sessions` SET `public_id` = lower(hex(randomblob(16))) WHERE `public_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_public_id_idx` ON `sessions` (`public_id`);
