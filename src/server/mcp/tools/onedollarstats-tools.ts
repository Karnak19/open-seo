import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  OneDollarStatsReportingService,
  type OneDollarStatsOverviewResult,
  type OneDollarStatsReportInput,
  type OneDollarStatsReportResult,
} from "@/server/features/onedollarstats/services/OneDollarStatsReportingService";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { looseObjectOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpTable, percentCell } from "@/server/mcp/table";
import { analyticsEnvelopeSchema } from "@/server/mcp/tools/google-analytics-tools";
import { buildDashboardUrl } from "@/server/mcp/urls";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Inclusive YYYY-MM-DD date. Provide both startDate and endDate.");

const channelSchema = z
  .enum(["organic_search", "all"])
  .optional()
  .default("organic_search")
  .describe(
    "organic_search keeps visits OneDollarStats classifies as Organic Search (Google, Bing, DuckDuckGo, and others). all includes every visit.",
  );

const commonInputSchema = {
  projectId: projectIdSchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  limit: z.number().int().min(1).max(1_000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
} as const;

const reportOutputSchema = analyticsEnvelopeSchema({
  source: looseObjectOutputSchema,
  request: looseObjectOutputSchema,
  rowCount: z.number(),
  rows: z.array(z.record(z.string(), z.unknown())),
  pageInfo: looseObjectOutputSchema,
  warnings: z.array(z.string()),
});

const overviewOutputSchema = analyticsEnvelopeSchema({
  source: looseObjectOutputSchema,
  request: looseObjectOutputSchema,
  current: looseObjectOutputSchema,
  previous: looseObjectOutputSchema,
  comparison: looseObjectOutputSchema,
  trend: z.array(z.record(z.string(), z.unknown())),
  warnings: z.array(z.string()),
});

const SCOPE_NOTE =
  "Reads only the OneDollarStats site already connected to an OpenSEO project the caller is authorized to access. The server selects the API key and site from that project's saved connection. Read-only and uses no OpenSEO credits.";

type ProjectArgs = { projectId: string };
type ProjectContext = {
  auth: { organizationId: string };
  baseUrl: string;
  project: unknown;
};

// Codes the user fixes in project settings rather than by retrying.
const SETTINGS_CODES = new Set([
  "onedollarstats_not_connected",
  "onedollarstats_key_rejected",
]);

function errorResponse(
  args: ProjectArgs,
  context: ProjectContext,
  error: unknown,
): CallToolResult {
  if (!(error instanceof OneDollarStatsError)) throw error;
  const url = SETTINGS_CODES.has(error.code)
    ? buildDashboardUrl(
        context.baseUrl,
        `/p/${args.projectId}/settings/integrations`,
      )
    : undefined;
  return mcpResponse({
    text: `${error.message}${url ? ` Continue here: ${url}` : ""}`,
    meta: buildProjectMeta(context, args.projectId),
    structuredContent: {
      status: "error",
      error: { code: error.code, message: error.message, actionUrl: url },
    },
  });
}

function rangeNote(result: {
  warnings: string[];
  request: { resolvedDateRange: { endDate: string } };
}) {
  return result.warnings.includes("end_date_clamped")
    ? ` The requested endDate was moved back to ${result.request.resolvedDateRange.endDate}, the last complete day.`
    : "";
}

function channelNote(channel: string) {
  return channel === "organic_search"
    ? " Filtered to OneDollarStats' Organic Search channel; pass channel=all for every visit."
    : "";
}

function reportText(label: string, result: OneDollarStatsReportResult) {
  const range = result.request.resolvedDateRange;
  const paginate = result.pageInfo.hasMore
    ? " More rows are available; call again with offset to page through them."
    : "";
  const summary = `${label} (OneDollarStats: ${result.source.siteId}): ${result.rowCount} rows for ${range.startDate} through ${range.endDate}.${rangeNote(result)}${channelNote(result.request.channel)}${paginate}`;
  if (result.rows.length === 0) return summary;
  const columns = [...result.request.dimensions, ...result.request.metrics].map(
    (key) => ({
      header: key,
      value: (row: Record<string, unknown>) => row[key],
    }),
  );
  return `${summary}\n${formatMcpTable(result.rows, columns)}`;
}

function overviewText(result: OneDollarStatsOverviewResult) {
  const range = result.request.resolvedDateRange;
  const previous = result.request.previousDateRange;
  const summary = `OneDollarStats overview for ${result.source.siteId}, ${range.startDate} through ${range.endDate}, compared with ${previous.startDate} through ${previous.endDate}.${rangeNote(result)}${channelNote(result.request.channel)}`;
  // bounceRate is a 0-1 ratio; the counts render as-is.
  const cell = (metric: string, value: number | null) =>
    metric === "bounceRate" && value !== null ? percentCell(value) : value;
  const totals = formatMcpTable(
    (["visits", "visitors", "pageviews", "bounceRate"] as const).map(
      (metric) => ({
        metric,
        current: cell(metric, result.current[metric]),
        previous: cell(metric, result.previous[metric]),
      }),
    ),
    [
      { header: "metric", value: (row) => row.metric },
      { header: "current", value: (row) => row.current },
      { header: "previous", value: (row) => row.previous },
    ],
  );
  const trend = formatMcpTable(result.trend, [
    { header: "date", value: (row) => row.date },
    { header: "visits", value: (row) => row.visits },
    { header: "visitors", value: (row) => row.visitors },
  ]);
  const trendLabel =
    result.request.trend === "daily" ? "Daily trend" : "Monthly trend";
  return `${summary}\n${totals}\n${trendLabel}:\n${trend}`;
}

function createReportHandler<TArgs extends ProjectArgs>(
  label: string,
  toInput: (args: TArgs) => OneDollarStatsReportInput,
) {
  return withMcpProjectAuth(async (args: TArgs, context) => {
    try {
      const result = await OneDollarStatsReportingService.runReport(
        toInput(args),
      );
      return mcpResponse({
        text: reportText(label, result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: result,
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  });
}

const annotations = {
  readOnlyHint: true,
  openWorldHint: true,
  destructiveHint: false,
} as const;

const overviewInputSchema = z.strictObject({
  projectId: projectIdSchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  channel: channelSchema,
});
type OverviewArgs = z.infer<typeof overviewInputSchema>;

export const getOneDollarStatsOrganicOverviewTool = {
  name: "get_onedollarstats_organic_overview",
  config: {
    title: "Get OneDollarStats organic overview",
    description: `Answer whether organic traffic is improving from the project's connected OneDollarStats site: visits, visitors, pageviews, bounce rate, and average visit duration, an equal-length previous-period comparison, and a daily visits trend (monthly for ranges over 180 days). Defaults to the last 28 complete days. ${SCOPE_NOTE}`,
    inputSchema: overviewInputSchema,
    outputSchema: overviewOutputSchema,
    annotations,
  },
  handler: withMcpProjectAuth(async (args: OverviewArgs, context) => {
    try {
      const result = await OneDollarStatsReportingService.getOverview(args);
      return mcpResponse({
        text: overviewText(result),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: result,
      });
    } catch (error) {
      return errorResponse(args, context, error);
    }
  }),
};

const landingPagesInputSchema = z.strictObject({
  ...commonInputSchema,
  channel: channelSchema,
});
type LandingPagesArgs = z.infer<typeof landingPagesInputSchema>;

export const getOneDollarStatsLandingPagesTool = {
  name: "get_onedollarstats_landing_pages",
  config: {
    title: "Get OneDollarStats landing pages",
    description: `Read entry pages with visits and visitors from the project's connected OneDollarStats site. Organic Search is the default, so the rows line up with Search Console pages; set channel to all for every entry. ${SCOPE_NOTE}`,
    inputSchema: landingPagesInputSchema,
    outputSchema: reportOutputSchema,
    annotations,
  },
  handler: createReportHandler<LandingPagesArgs>("Landing pages", (args) => ({
    ...args,
    kind: "landing_pages",
  })),
};

const pagePerformanceInputSchema = z.strictObject(commonInputSchema);
type PagePerformanceArgs = z.infer<typeof pagePerformanceInputSchema>;

export const getOneDollarStatsPagePerformanceTool = {
  name: "get_onedollarstats_page_performance",
  config: {
    title: "Get OneDollarStats page performance",
    description: `Read pageviews, visitors, and visits per page from the project's connected OneDollarStats site, across all traffic. For organic entry pages, use get_onedollarstats_landing_pages. ${SCOPE_NOTE}`,
    inputSchema: pagePerformanceInputSchema,
    outputSchema: reportOutputSchema,
    annotations,
  },
  handler: createReportHandler<PagePerformanceArgs>(
    "Page performance",
    (args) => ({ ...args, kind: "page_performance" }),
  ),
};

const trafficSourcesInputSchema = z.strictObject({
  ...commonInputSchema,
  breakdown: z
    .enum(["source", "channel"])
    .optional()
    .default("source")
    .describe(
      "source lists referring sites; channel groups visits the way OneDollarStats does (Organic Search, Direct, Referral, and so on).",
    ),
  channel: channelSchema,
});
type TrafficSourcesArgs = z.infer<typeof trafficSourcesInputSchema>;

export const getOneDollarStatsTrafficSourcesTool = {
  name: "get_onedollarstats_traffic_sources",
  config: {
    title: "Get OneDollarStats traffic sources",
    description: `Compare where visits come from on the project's connected OneDollarStats site, by referring source (visits, visitors, and pageviews) or by channel (same metrics). The source breakdown can be limited to Organic Search; the channel breakdown always covers every visit. ${SCOPE_NOTE}`,
    inputSchema: trafficSourcesInputSchema,
    outputSchema: reportOutputSchema,
    annotations,
  },
  handler: createReportHandler<TrafficSourcesArgs>(
    "Traffic sources",
    (args) => ({
      projectId: args.projectId,
      startDate: args.startDate,
      endDate: args.endDate,
      limit: args.limit,
      offset: args.offset,
      channel: args.channel,
      kind: args.breakdown === "channel" ? "channels" : "traffic_sources",
    }),
  ),
};
