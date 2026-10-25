import {
  ga4DateInTimeZone,
  inclusiveGa4Days,
  shiftGa4Date,
} from "@/server/features/ga4/services/Ga4Dates";
import {
  comparisonValue,
  previousPeriod,
} from "@/server/features/ga4/services/Ga4ReportEnhancements";
import { sort } from "remeda";
import { OneDollarStatsService } from "./OneDollarStatsService";
import type { OneDollarStatsMetric } from "@/server/lib/onedollarstatsClient";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";

export type OneDollarStatsChannel = "organic_search" | "all";

type OneDollarStatsReportKind = "pages" | "sources";

type DateRange = { startDate: string; endDate: string };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
// The stats API caps a query at 10 000 rows when no pagination is sent.
const RAW_ROW_CAP = 10_000;

// OneDollarStats' `matches` filter breaks server-side on any non-trivial
// regex (groups, quantifiers — verified against the live API), so organic
// reports never filter server-side: they group by the visit's referrer and
// this regex classifies the rows here instead. It keeps search-engine
// domains and their www., m. and regional subdomains while leaving
// gemini.google.com- or news.google.com-style product subdomains out. Same
// shape as the Umami integration's filter.
const SEARCH_REFERRER_PATTERN =
  /^((www|m|[a-z]{2})\.)?(([a-z]{2}\.)?search\.)?(google|bing|duckduckgo|ecosia|yandex|baidu|yahoo|qwant|startpage|brave|naver|seznam|msn)\.|^ya\.ru$|^com\.google\.android\.googlequicksearchbox/;

function isSearchReferrer(value: string | null | undefined): boolean {
  return value != null && SEARCH_REFERRER_PATTERN.test(value);
}

const REPORTS = {
  pages: {
    dimension: "event:page",
    label: "pagePath",
    metrics: ["pageviews", "visitors", "visits"] as OneDollarStatsMetric[],
  },
  sources: {
    dimension: "visit:referrer",
    label: "source",
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
 *  connection's time zone, with a future endDate moved back to yesterday. */
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

/** OneDollarStats reads a date pair as literal UTC instants (a bare date is
 *  its midnight, so the end date's day would be missed), so the range is sent
 *  as whole UTC days. */
function toInstantRange(range: DateRange): [string, string] {
  return [`${range.startDate}T00:00:00.000Z`, `${range.endDate}T23:59:59.999Z`];
}

// OneDollarStats reports bounce rate as a percentage; the dashboard shows a
// 0-1 ratio like GA4's engagement rate.
function asRatio(value: number | null): number | null {
  return value == null ? null : value > 1 ? value / 100 : value;
}

type Row = {
  metrics: Array<number | null>;
  dimensions?: Array<string | null>;
};

/**
 * Totals over (possibly per-referrer grouped) rows: counts sum, rates become
 * visit-weighted averages. Visitors sum per source, so a visitor who arrived
 * from two sources counts twice — the API offers no deduplicated filtered
 * total. A plain unfiltered row aggregates to itself.
 */
function aggregateTotals(rows: Row[]) {
  let visitors = 0;
  let visits = 0;
  let pageviews = 0;
  let bounceWeighted = 0;
  let durationWeighted = 0;
  let weightedVisits = 0;
  for (const row of rows) {
    const [rowVisitors, rowVisits, rowPageviews, rowBounce, rowDuration] =
      row.metrics;
    visitors += rowVisitors ?? 0;
    pageviews += rowPageviews ?? 0;
    if (rowVisits == null) continue;
    visits += rowVisits;
    if (rowBounce != null) bounceWeighted += rowBounce * rowVisits;
    if (rowDuration != null) durationWeighted += rowDuration * rowVisits;
    weightedVisits += rowVisits;
  }
  return {
    visits,
    visitors,
    pageviews,
    bounceRate:
      weightedVisits > 0 ? asRatio(bounceWeighted / weightedVisits) : null,
    avgVisitDurationSeconds:
      weightedVisits > 0 ? durationWeighted / weightedVisits : null,
  };
}

type TrendUnit = "day" | "month";

// A day bucket's label starts with the ISO date, a month bucket's with the
// ISO month; buckets with no traffic are omitted from the response.
function bucketKey(value: string | null | undefined, unit: TrendUnit) {
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

/**
 * Zero-fill the per-day series across the range: OneDollarStats omits empty
 * days, and the organic trend arrives grouped by (day, referrer) so the days
 * are summed here too.
 */
function fillTrend(rows: Row[], range: DateRange, unit: TrendUnit) {
  const visits = new Map<string, number>();
  const visitors = new Map<string, number>();
  for (const row of rows) {
    const key = bucketKey(row.dimensions?.[0], unit);
    if (!key) continue;
    visits.set(key, (visits.get(key) ?? 0) + (row.metrics[0] ?? 0));
    visitors.set(key, (visitors.get(key) ?? 0) + (row.metrics[1] ?? 0));
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

  const totalsQuery = (range: DateRange) => ({
    metrics: OVERVIEW_METRICS_REQUEST,
    dateRange: toInstantRange(range),
    dimensions: organic ? ["visit:referrer"] : undefined,
  });
  const trendQuery = {
    metrics: ["visits", "visitors"] as OneDollarStatsMetric[],
    dateRange: toInstantRange(resolvedDateRange),
    dimensions: [
      ...(unit === "day" ? ["time:day"] : ["time:month"]),
      ...(organic ? ["visit:referrer"] : []),
    ],
  };

  const [currentRows, previousRows, trendRows] = await Promise.all([
    client.runQuery(connection.siteId, totalsQuery(resolvedDateRange)),
    client.runQuery(connection.siteId, totalsQuery(previousDateRange)),
    client.runQuery(connection.siteId, trendQuery),
  ]);
  const current = aggregateTotals(
    currentRows.results.filter(
      (row) => !organic || isSearchReferrer(row.dimensions?.[0]),
    ),
  );
  const previous = aggregateTotals(
    previousRows.results.filter(
      (row) => !organic || isSearchReferrer(row.dimensions?.[0]),
    ),
  );
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
    trend: fillTrend(
      trendRows.results.filter(
        (row) => !organic || isSearchReferrer(row.dimensions?.[1]),
      ),
      resolvedDateRange,
      unit,
    ),
    warnings: dateRange.warnings,
  };
}

export type OneDollarStatsReportInput = {
  projectId: string;
  kind: OneDollarStatsReportKind;
  channel?: OneDollarStatsChannel;
  /** Which dimension the sources report groups by. */
  breakdown?: "referrer" | "utm_source";
  startDate?: string;
  endDate?: string;
  limit?: number;
};

/**
 * Runs one grouped report. Rows arrive (and, when the referrer had to ride
 * along as the organic classification's dimension, are re-aggregated) per
 * dimension value — null referrers become "(direct)" — sorted by the first
 * metric, capped at `limit` with `truncated` saying whether anything was cut.
 */
async function runReport(input: OneDollarStatsReportInput) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new OneDollarStatsError(
      "validation_error",
      `limit must be an integer from 1 to ${MAX_LIMIT}.`,
    );
  }
  const { connection, client } = await OneDollarStatsService.openConnection(
    input.projectId,
  );
  const organic = input.channel === "organic_search";
  const definition = REPORTS[input.kind];
  const dimension =
    input.kind === "sources" && input.breakdown === "utm_source"
      ? "visit:utm_source"
      : definition.dimension;
  // Organic rows are classified by their referrer, so it rides along as a
  // dimension (unless it is the report's own) and is filtered on here, where
  // a real regex engine exists.
  const needsReferrerDimension = organic && dimension !== "visit:referrer";

  const dateRange = resolveOneDollarStatsDateRange(input, connection.timeZone);
  const warnings = [...dateRange.warnings];
  // No explicit pagination: the API's default cap is RAW_ROW_CAP rows.
  const result = await client.runQuery(connection.siteId, {
    metrics: definition.metrics,
    dateRange: toInstantRange(dateRange.resolvedDateRange),
    dimensions: [
      dimension,
      ...(needsReferrerDimension ? ["visit:referrer"] : []),
    ],
    orderBy: [[definition.metrics[0], "desc"]],
  });
  if (result.results.length >= RAW_ROW_CAP) warnings.push("raw_rows_capped");

  const groups = new Map<string, number[]>();
  for (const row of result.results) {
    if (
      organic &&
      (needsReferrerDimension
        ? !isSearchReferrer(row.dimensions?.[1])
        : !isSearchReferrer(row.dimensions?.[0]))
    ) {
      continue;
    }
    const key = row.dimensions?.[0] ?? "(direct)";
    const totals = groups.get(key) ?? definition.metrics.map(() => 0);
    definition.metrics.forEach((_, index) => {
      totals[index] += row.metrics[index] ?? 0;
    });
    groups.set(key, totals);
  }
  const rows = sort([...groups.entries()], (a, b) => b[1][0] - a[1][0])
    .slice(0, limit)
    .map(([value, totals]) => ({
      [definition.label]: value,
      ...Object.fromEntries(
        definition.metrics.map((name, index) => [name, totals[index]]),
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
      channel: organic ? ("organic_search" as const) : ("all" as const),
      dimensions: [definition.label],
      metrics: [...definition.metrics],
    },
    rowCount: rows.length,
    rows,
    truncated:
      result.results.length >= RAW_ROW_CAP || groups.size > rows.length,
    warnings,
  };
}

export type OneDollarStatsReportResult = Awaited<ReturnType<typeof runReport>>;
export type OneDollarStatsOverviewResult = Awaited<
  ReturnType<typeof getOverview>
>;

export const OneDollarStatsReportingService = { getOverview, runReport };
