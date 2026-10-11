CREATE TABLE `worker_heartbeats` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `worker_heartbeats_seen_idx` ON `worker_heartbeats` (`last_seen_at`);