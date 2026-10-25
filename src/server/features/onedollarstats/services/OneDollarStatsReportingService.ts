import {
  ga4DateInTimeZone,
  inclusiveGa4Days,
  shiftGa4Date,
} from "@/server/features/ga4/services/Ga4Dates";
import {
  comparisonValue,
  previousPeriod,
} from "@/server/features/ga4/services/Ga4ReportEnhancements";
import { OneDollarStatsService } from "./OneDollarStatsService";
import type { OneDollarStatsMetric } from "@/server/lib/onedollarstatsClient";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";

export type OneDollarStatsChannel = "organic_search" | "all";

type OneDollarStatsReportKind =
  | "landing_pages"
  | "page_performance"
  | "traffic_sources"
  | "channels";

type DateRange = { startDate: string; endDate: string };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

// OneDollarStats classifies every visit into a channel; this is its name for
// search-engine visits. Unlike the referrer approximation some APIs need, the
// channel is visit-scoped, so session metrics stay meaningful under it.
const ORGANIC_CHANNEL = "Organic Search";

const organicFilter = [["is", "visit:channel", [ORGANIC_CHANNEL]]];

const REPORTS = {
  landing_pages: {
    dimension: "visit:entry_page",
    label: "entryPage",
    metrics: ["visits", "visitors"] as OneDollarStatsMetric[],
  },
  page_performance: {
    dimension: "event:page",
    label: "pagePath",
    metrics: ["pageviews", "visitors", "visits"] as OneDollarStatsMetric[],
  },
  traffic_sources: {
    dimension: "visit:source",
    label: "source",
    metrics: ["visits", "visitors", "pageviews"] as OneDollarStatsMetric[],
  },
  channels: {
    dimension: "visit:channel",
    label: "channel",
    metrics: ["visits", "visitors", "pageviews"] as OneDollarStatsMetric[],
  },
} as const;

const OVERVIEW_METRICS_REQUEST: OneDollarStatsMetric[] = [
  "visitors",
  "visits",
  "pageviews",
  "bounce_rate",
  "visit_duration",
];

const OVERVIEW_METRICS = [
  "visits",
  "visitors",
  "pageviews",
  "bounceRate",
  "avgVisitDurationSeconds",
] as const;

function parseDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
  );
}

/** Same defaults as the GA4 reports: the last 28 complete days in the
 *  connection's time zone, with a future endDate moved back to yesterday.
 *  OneDollarStats takes date strings, so the range needs no zone math. */
function resolveOneDollarStatsDateRange(
  input: { startDate?: string; endDate?: string },
  timeZone: string,
  now: Date = new Date(),
) {
  if (Boolean(input.startDate) !== Boolean(input.endDate)) {
    throw new OneDollarStatsError(
      "validation_error",
      "Provide both startDate and endDate, or neither.",
    );
  }
  const requestedDateRange =
    input.startDate && input.endDate
      ? { startDate: input.startDate, endDate: input.endDate }
      : null;
  if (
    requestedDateRange &&
    (!parseDate(requestedDateRange.startDate) ||
      !parseDate(requestedDateRange.endDate) ||
      requestedDateRange.startDate > requestedDateRange.endDate)
  ) {
    throw new OneDollarStatsError(
      "validation_error",
      "Dates must be valid YYYY-MM-DD values with startDate on or before endDate.",
    );
  }
  const lastCompleteDay = shiftGa4Date(ga4DateInTimeZone(now, timeZone), -1);
  let endDate = requestedDateRange?.endDate ?? lastCompleteDay;
  const startDate = requestedDateRange?.startDate ?? shiftGa4Date(endDate, -27);
  const warnings: string[] = [];
  if (endDate > lastCompleteDay) {
    endDate = lastCompleteDay;
    warnings.push("end_date_clamped");
  }
  if (startDate > endDate) {
    throw new OneDollarStatsError(
      "validation_error",
      "The resolved startDate is after the last complete day.",
    );
  }
  return {
    requestedDateRange,
    resolvedDateRange: { startDate, endDate },
    warnings,
  };
}

// OneDollarStats reports bounce rate as a percentage; the dashboard shows a
// 0-1 ratio like GA4's engagement rate.
function asRatio(value: number | null): number | null {
  return value == null ? null : value > 1 ? value / 100 : value;
}

function summarize(row: { metrics: Array<number | null> } | undefined) {
  const metric = (index: number): number | null =>
    typeof row?.metrics[index] === "number" ? row.metrics[index] : null;
  return {
    visits: metric(1) ?? 0,
    visitors: metric(0) ?? 0,
    pageviews: metric(2) ?? 0,
    bounceRate: asRatio(metric(3)),
    avgVisitDurationSeconds: metric(4),
  };
}

type TrendUnit = "day" | "month";

// A day bucket's label starts with the ISO date, a month bucket's with the
// ISO month; buckets with no traffic are omitted from the response.
function bucketKey(value: string | undefined, unit: TrendUnit): string | null {
  const sliced = value?.slice(0, unit === "day" ? 10 : 7) ?? "";
  return unit === "day"
    ? /^\d{4}-\d{2}-\d{2}$/.test(sliced)
      ? sliced
      : null
    : /^\d{4}-\d{2}$/.test(sliced)
      ? sliced
      : null;
}

function periods(range: DateRange, unit: TrendUnit): string[] {
  if (unit === "day") {
    const days: string[] = [];
    for (
      let date = range.startDate;
      date <= range.endDate;
      date = shiftGa4Date(date, 1)
    ) {
      days.push(date);
    }
    return days;
  }
  const months: string[] = [];
  let [year, month] = range.startDate.split("-").map(Number);
  const last = range.endDate.slice(0, 7);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    if (key > last) break;
    months.push(key);
    month = month === 12 ? 1 : month + 1;
    if (month === 1) year += 1;
  }
  return months;
}

/** Zero-fill the series across the range: OneDollarStats omits empty days. */
function fillTrend(
  result: {
    results: Array<{ metrics: Array<number | null>; dimensions?: string[] }>;
  },
  range: DateRange,
  unit: TrendUnit,
) {
  const visits = new Map<string, number>();
  const visitors = new Map<string, number>();
  for (const row of result.results) {
    const key = bucketKey(row.dimensions?.[0], unit);
    if (!key) continue;
    visits.set(key, row.metrics[0] ?? 0);
    visitors.set(key, row.metrics[1] ?? 0);
  }
  return periods(range, unit).map((date) => ({
    date,
    visits: visits.get(date) ?? 0,
    visitors: visitors.get(date) ?? 0,
  }));
}

async function getOverview(
  input: {
    projectId: string;
    startDate?: string;
    endDate?: string;
    channel?: OneDollarStatsChannel;
  },
  opts: { now?: Date } = {},
) {
  const { connection, client } = await OneDollarStatsService.openConnection(
    input.projectId,
  );
  const channel = input.channel ?? "organic_search";
  const organic = channel === "organic_search";
  const dateRange = resolveOneDollarStatsDateRange(
    input,
    connection.timeZone,
    opts.now,
  );
  const { resolvedDateRange } = dateRange;
  const previousDateRange = previousPeriod(resolvedDateRange);
  const unit: TrendUnit =
    inclusiveGa4Days(resolvedDateRange.startDate, resolvedDateRange.endDate) >
    180
      ? "month"
      : "day";
  const filters = organic ? organicFilter : [];

  const [currentResult, previousResult, trendResult] = await Promise.all([
    client.runQuery(connection.siteId, {
      metrics: OVERVIEW_METRICS_REQUEST,
      dateRange: [resolvedDateRange.startDate, resolvedDateRange.endDate],
      filters,
    }),
    client.runQuery(connection.siteId, {
      metrics: OVERVIEW_METRICS_REQUEST,
      dateRange: [previousDateRange.startDate, previousDateRange.endDate],
      filters,
    }),
    client.runQuery(connection.siteId, {
      metrics: ["visits", "visitors"],
      dateRange: [resolvedDateRange.startDate, resolvedDateRange.endDate],
      dimensions: [unit === "day" ? "time:day" : "time:month"],
      filters,
    }),
  ]);
  const current = summarize(currentResult.results[0]);
  const previous = summarize(previousResult.results[0]);
  return {
    status: "ok" as const,
    source: {
      provider: "onedollarstats" as const,
      siteId: connection.siteId,
    },
    request: {
      requestedDateRange: dateRange.requestedDateRange,
      resolvedDateRange,
      previousDateRange,
      timeZone: connection.timeZone,
      channel,
      trend: unit === "day" ? ("daily" as const) : ("monthly" as const),
    },
    current,
    previous,
    comparison: Object.fromEntries(
      OVERVIEW_METRICS.map((metric) => [
        metric,
        comparisonValue(current[metric], previous[metric]),
      ]),
    ),
    trend: fillTrend(trendResult, resolvedDateRange, unit),
    warnings: dateRange.warnings,
  };
}

export type OneDollarStatsReportInput = {
  projectId: string;
  kind: OneDollarStatsReportKind;
  channel?: OneDollarStatsChannel;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
};

async function runReport(input: OneDollarStatsReportInput) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new OneDollarStatsError(
      "validation_error",
      `limit must be an integer from 1 to ${MAX_LIMIT}.`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new OneDollarStatsError(
      "validation_error",
      "offset must be a non-negative integer.",
    );
  }
  const { connection, client } = await OneDollarStatsService.openConnection(
    input.projectId,
  );
  const definition = REPORTS[input.kind];
  // The channel report is itself the channel split, and pageviews per page
  // under the organic filter would count only landing hits, so neither is
  // filtered.
  const channel =
    input.kind === "channels" || input.kind === "page_performance"
      ? "all"
      : (input.channel ?? "organic_search");
  const dateRange = resolveOneDollarStatsDateRange(input, connection.timeZone);

  // One extra row tells whether another page exists beyond the page asked for.
  const result = await client.runQuery(connection.siteId, {
    metrics: definition.metrics,
    dateRange: [
      dateRange.resolvedDateRange.startDate,
      dateRange.resolvedDateRange.endDate,
    ],
    dimensions: [definition.dimension],
    filters: channel === "organic_search" ? organicFilter : [],
    orderBy: [[definition.metrics[0], "desc"]],
    limit: limit + 1,
  });
  const rows = result.results.slice(0, limit).map((row) => ({
    [definition.label]: row.dimensions?.[0] ?? "",
    ...Object.fromEntries(
      definition.metrics.map((name, index) => [name, row.metrics[index]]),
    ),
  }));
  return {
    status: "ok" as const,
    source: {
      provider: "onedollarstats" as const,
      siteId: connection.siteId,
    },
    request: {
      reportKind: input.kind,
      requestedDateRange: dateRange.requestedDateRange,
      resolvedDateRange: dateRange.resolvedDateRange,
      timeZone: connection.timeZone,
      channel,
      dimensions: [definition.label],
      metrics: [...definition.metrics],
    },
    rowCount: rows.length,
    rows,
    pageInfo: { limit, offset, hasMore: result.results.length > limit },
    warnings: dateRange.warnings,
  };
}

export type OneDollarStatsReportResult = Awaited<ReturnType<typeof runReport>>;
export type OneDollarStatsOverviewResult = Awaited<
  ReturnType<typeof getOverview>
>;

export const OneDollarStatsReportingService = { getOverview, runReport };
