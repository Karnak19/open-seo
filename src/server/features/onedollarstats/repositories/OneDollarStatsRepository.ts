import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  oneDollarStatsConnections,
  oneDollarStatsInstances,
} from "@/db/schema";

export type OneDollarStatsInstance =
  typeof oneDollarStatsInstances.$inferSelect;
type OneDollarStatsConnection = typeof oneDollarStatsConnections.$inferSelect;

async function getInstance(
  organizationId: string,
): Promise<OneDollarStatsInstance | null> {
  const rows = await db
    .select()
    .from(oneDollarStatsInstances)
    .where(eq(oneDollarStatsInstances.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsertInstance(input: {
  organizationId: string;
  encryptedApiKey: string;
  savedByUserId: string;
}): Promise<OneDollarStatsInstance> {
  const [row] = await db
    .insert(oneDollarStatsInstances)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: oneDollarStatsInstances.organizationId,
      set: {
        encryptedApiKey: input.encryptedApiKey,
        savedByUserId: input.savedByUserId,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert onedollarstats_instance");
  return row;
}

/** Deleting the instance cascades to every project connection that uses it. */
async function deleteInstance(organizationId: string): Promise<void> {
  await db
    .delete(oneDollarStatsInstances)
    .where(eq(oneDollarStatsInstances.organizationId, organizationId));
}

async function getConnection(
  projectId: string,
): Promise<OneDollarStatsConnection | null> {
  const rows = await db
    .select()
    .from(oneDollarStatsConnections)
    .where(eq(oneDollarStatsConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

/** The project's connection together with the instance it reads from. */
async function getConnectionWithInstance(projectId: string) {
  const rows = await db
    .select({
      connection: oneDollarStatsConnections,
      instance: oneDollarStatsInstances,
    })
    .from(oneDollarStatsConnections)
    .innerJoin(
      oneDollarStatsInstances,
      and(
        eq(oneDollarStatsInstances.id, oneDollarStatsConnections.instanceId),
        eq(
          oneDollarStatsInstances.organizationId,
          oneDollarStatsConnections.organizationId,
        ),
      ),
    )
    .where(eq(oneDollarStatsConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsertConnection(input: {
  projectId: string;
  organizationId: string;
  instanceId: string;
  siteId: string;
  timeZone: string;
  connectedByUserId: string;
}): Promise<OneDollarStatsConnection> {
  const [row] = await db
    .insert(oneDollarStatsConnections)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: oneDollarStatsConnections.projectId,
      set: {
        organizationId: input.organizationId,
        instanceId: input.instanceId,
        siteId: input.siteId,
        timeZone: input.timeZone,
        connectedByUserId: input.connectedByUserId,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert onedollarstats_connection");
  return row;
}

async function deleteConnection(projectId: string): Promise<void> {
  await db
    .delete(oneDollarStatsConnections)
    .where(eq(oneDollarStatsConnections.projectId, projectId));
}

export const OneDollarStatsRepository = {
  getInstance,
  upsertInstance,
  deleteInstance,
  getConnection,
  getConnectionWithInstance,
  upsertConnection,
  deleteConnection,
};
