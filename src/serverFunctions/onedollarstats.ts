import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { OneDollarStatsReportingService } from "@/server/features/onedollarstats/services/OneDollarStatsReportingService";
import { OneDollarStatsService } from "@/server/features/onedollarstats/services/OneDollarStatsService";
import { AppError } from "@/server/lib/errors";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";
import { hasOrgPermission } from "@/lib/org-permissions";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });

const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      const format = new Intl.DateTimeFormat("en-US", { timeZone: value });
      return Boolean(format.resolvedOptions().timeZone);
    } catch {
      return false;
    }
  }, "Unknown time zone");

const connectSchema = projectScopedSchema.extend({
  // Omitted to reuse the API key already saved for the organization.
  apiKey: z.string().trim().min(1).max(4096).optional(),
  siteId: z.string().trim().min(1).max(255),
  timeZone: timeZoneSchema,
});

export const getOneDollarStatsConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const [row, hasApiKey, encryptionConfigured] = await Promise.all([
      OneDollarStatsService.getConnection(context.projectId),
      OneDollarStatsService.hasApiKey(context.organizationId),
      OneDollarStatsService.isEncryptionConfigured(),
    ]);
    return {
      connected: Boolean(row),
      canManage: hasOrgPermission(context.role, { integration: ["manage"] }),
      encryptionConfigured,
      hasApiKey,
      siteId: row?.connection.siteId ?? null,
      connectedAt: row?.connection.createdAt ?? null,
    };
  });

export const connectOneDollarStats = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(connectSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    const result = await OneDollarStatsService.connect({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      apiKey: data.apiKey ?? null,
      siteId: data.siteId,
      timeZone: data.timeZone,
    });
    if ("siteId" in result) {
      waitUntil(
        captureServerEvent({
          distinctId: context.userId,
          event: "onedollarstats:connect",
          organizationId: context.organizationId,
          properties: {
            project_id: context.projectId,
            reused_org_key: !data.apiKey,
          },
        }),
      );
    }
    return result;
  });

export const disconnectOneDollarStats = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { integration: ["manage"] });
    await OneDollarStatsService.disconnect(data.projectId);
    return { success: true as const };
  });

/** The dashboard's OneDollarStats card: organic totals vs the previous period
 *  plus a daily visits trend, over the default (last 28 complete days)
 *  range. */
export const getOneDollarStatsDashboardReport = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    try {
      const overview = await OneDollarStatsReportingService.getOverview({
        projectId: context.projectId,
      });
      return {
        status: "ok" as const,
        siteId: overview.source.siteId,
        totals: overview.current,
        prevTotals: overview.previous,
        trend: overview.trend,
      };
    } catch (error) {
      if (error instanceof OneDollarStatsError) {
        if (error.code === "onedollarstats_not_connected") {
          return { status: "not_connected" as const };
        }
        // Faults on OneDollarStats' side or the saved key's, not app faults:
        // the card shows its own message, and error tracking skips them.
        if (error.code === "onedollarstats_rate_limited") {
          throw new AppError("RATE_LIMITED");
        }
        return {
          status: "error" as const,
          error: { code: error.code, message: error.message },
        };
      }
      throw error;
    }
  });
