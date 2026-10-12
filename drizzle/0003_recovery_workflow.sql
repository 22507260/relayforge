CREATE TABLE `recovery_demos` (
	`owner` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`event_id` text NOT NULL,
	`previous_event_id` text,
	`created_at` integer NOT NULL,
	`repaired_at` integer,
	FOREIGN KEY (`owner`) REFERENCES `workspaces`(`owner`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `activity` ADD `cycle` integer;--> statement-breakpoint
ALTER TABLE `activity` ADD `operation_id` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `cycle` integer;--> statement-breakpoint
ALTER TABLE `deliveries` ADD `current_cycle` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `purpose` text DEFAULT 'standard' NOT NULL;