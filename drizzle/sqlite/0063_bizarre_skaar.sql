CREATE TABLE `onedollarstats_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`site_id` text NOT NULL,
	`time_zone` text NOT NULL,
	`connected_by_user_id` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instance_id`) REFERENCES `onedollarstats_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onedollarstats_connections_project_idx` ON `onedollarstats_connections` (`project_id`);--> statement-breakpoint
CREATE INDEX `onedollarstats_connections_organization_idx` ON `onedollarstats_connections` (`organization_id`);--> statement-breakpoint
CREATE INDEX `onedollarstats_connections_instance_idx` ON `onedollarstats_connections` (`instance_id`);--> statement-breakpoint
CREATE TABLE `onedollarstats_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`saved_by_user_id` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onedollarstats_instances_organization_idx` ON `onedollarstats_instances` (`organization_id`);