CREATE TABLE `connection_signing_keys` (
	`key_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`encrypted_secret` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`owner`) REFERENCES `workspaces`(`owner`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `connection_signing_keys_endpoint_idx` ON `connection_signing_keys` (`owner`,`endpoint_id`);--> statement-breakpoint
CREATE TABLE `producer_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`scope` text DEFAULT 'events:write' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`owner`) REFERENCES `workspaces`(`owner`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`endpoint_id`) REFERENCES `endpoints`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `producer_keys_hash_idx` ON `producer_keys` (`token_hash`);--> statement-breakpoint
CREATE INDEX `producer_keys_owner_idx` ON `producer_keys` (`owner`,`created_at`);--> statement-breakpoint
CREATE TABLE `producer_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`window_start` integer NOT NULL,
	`attempts` integer NOT NULL,
	`last_request_id` text NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `workspaces`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `attempts` ADD `failure_code` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `signing_key_ids` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `connection_revision` integer;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `transport` text DEFAULT 'demo' NOT NULL;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `destination_url` text;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `endpoints` ADD `signing_key_id` text;