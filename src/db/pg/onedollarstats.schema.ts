import { sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Keep these definitions structurally identical to ../onedollarstats.schema.ts.
export const oneDollarStatsInstances = pgTable(
  "onedollarstats_instances",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    savedByUserId: text("saved_by_user_id").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("onedollarstats_instances_organization_idx").on(
      table.organizationId,
    ),
  ],
);

export const oneDollarStatsConnections = pgTable(
  "onedollarstats_connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    instanceId: text("instance_id")
      .notNull()
      .references(() => oneDollarStatsInstances.id, { onDelete: "cascade" }),
    siteId: text("site_id").notNull(),
    timeZone: text("time_zone").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    createdAt: text("created_at").notNull().default(isoNow),
    updatedAt: text("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("onedollarstats_connections_project_idx").on(table.projectId),
    index("onedollarstats_connections_organization_idx").on(
      table.organizationId,
    ),
    index("onedollarstats_connections_instance_idx").on(table.instanceId),
  ],
);
