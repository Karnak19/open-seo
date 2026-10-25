import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";
import { organization } from "./better-auth-schema";

// One OneDollarStats API key per organization, shared by every project that
// reads a site from it. The key is encrypted and never returned to the client.
// saved_by_user_id is whoever last entered the key: the person whose secret
// this row holds, which is what GDPR erasure removes.
export const oneDollarStatsInstances = sqliteTable(
  "onedollarstats_instances",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    savedByUserId: text("saved_by_user_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("onedollarstats_instances_organization_idx").on(
      table.organizationId,
    ),
  ],
);

// The OneDollarStats site a project reads its analytics from. site_id is the
// hostname OneDollarStats keys queries on, e.g. "example.com".
export const oneDollarStatsConnections = sqliteTable(
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
    // IANA zone used for day boundaries. OneDollarStats sites carry none, so
    // the browser's zone is captured when the site is connected.
    timeZone: text("time_zone").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("onedollarstats_connections_project_idx").on(table.projectId),
    index("onedollarstats_connections_organization_idx").on(
      table.organizationId,
    ),
    index("onedollarstats_connections_instance_idx").on(table.instanceId),
  ],
);
