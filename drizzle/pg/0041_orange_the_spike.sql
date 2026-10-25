CREATE TABLE "onedollarstats_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"site_id" text NOT NULL,
	"time_zone" text NOT NULL,
	"connected_by_user_id" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onedollarstats_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"saved_by_user_id" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onedollarstats_connections" ADD CONSTRAINT "onedollarstats_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onedollarstats_connections" ADD CONSTRAINT "onedollarstats_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onedollarstats_connections" ADD CONSTRAINT "onedollarstats_connections_instance_id_onedollarstats_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."onedollarstats_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onedollarstats_instances" ADD CONSTRAINT "onedollarstats_instances_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "onedollarstats_connections_project_idx" ON "onedollarstats_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "onedollarstats_connections_organization_idx" ON "onedollarstats_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "onedollarstats_connections_instance_idx" ON "onedollarstats_connections" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onedollarstats_instances_organization_idx" ON "onedollarstats_instances" USING btree ("organization_id");