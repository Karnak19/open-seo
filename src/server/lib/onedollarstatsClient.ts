import { z } from "zod";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";
import { readBoundedText } from "@/server/lib/scrape";

const STATS_API_URL = "https://api.onedollarstats.com/api";
const REQUEST_TIMEOUT_MS = 15_000;

export type OneDollarStatsMetric =
  | "visitors"
  | "visits"
  | "pageviews"
  | "views_per_visit"
  | "bounce_rate"
  | "visit_duration"
  | "events";

/** One stats query: metrics plus optional grouping, filtering and ordering. */
export type OneDollarStatsQuery = {
  metrics: OneDollarStatsMetric[];
  /** Preset ("30d") or an inclusive [start, end] pair of ISO dates. */
  dateRange: string | [string, string];
  dimensions?: string[];
  filters?: unknown[];
  orderBy?: Array<[string, "asc" | "desc"]>;
  limit?: number;
};

const queryResponseSchema = z.object({
  results: z.array(
    z.object({
      // Metric values in the requested order; null when not computable.
      metrics: z.array(z.union([z.number(), z.null()])),
      // Dimension values in the requested order. A visit with no referrer
      // reports a null referrer dimension, so any dimension can be null.
      dimensions: z.array(z.union([z.string(), z.null()])).optional(),
    }),
  ),
});

type OneDollarStatsQueryResult = z.infer<typeof queryResponseSchema>;

function statusError(status: number): OneDollarStatsError {
  // The observed contract: an invalid key answers 401, a key without access
  // to the requested site 403, so the two stay distinguishable.
  if (status === 401) {
    return new OneDollarStatsError(
      "onedollarstats_key_rejected",
      "OneDollarStats rejected the saved API key.",
      status,
    );
  }
  if (status === 403) {
    return new OneDollarStatsError(
      "onedollarstats_site_inaccessible",
      "OneDollarStats denied access to this site. Check that the hostname matches a site in your OneDollarStats account.",
      status,
    );
  }
  if (status === 429) {
    return new OneDollarStatsError(
      "onedollarstats_rate_limited",
      "OneDollarStats rate limit reached.",
      status,
    );
  }
  return new OneDollarStatsError(
    "onedollarstats_unreachable",
    `OneDollarStats answered with HTTP ${status}.`,
    status,
  );
}

/** A client for the OneDollarStats stats API under one API key. The key lives
 *  in memory only and never appears in errors or logs. */
export function createOneDollarStatsClient(opts: { apiKey: string }) {
  async function runQuery(
    siteId: string,
    query: OneDollarStatsQuery,
  ): Promise<OneDollarStatsQueryResult> {
    let response: Response;
    try {
      response = await fetch(STATS_API_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
        },
        body: JSON.stringify({
          site_id: siteId,
          metrics: query.metrics,
          date_range: query.dateRange,
          ...(query.dimensions ? { dimensions: query.dimensions } : {}),
          ...(query.filters ? { filters: query.filters } : {}),
          ...(query.orderBy ? { order_by: query.orderBy } : {}),
          ...(query.limit ? { pagination: { limit: query.limit } } : {}),
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new OneDollarStatsError(
        "onedollarstats_unreachable",
        "Could not reach OneDollarStats.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new OneDollarStatsError(
        "onedollarstats_unreachable",
        "OneDollarStats redirected the request.",
        response.status,
      );
    }
    if (!response.ok) throw statusError(response.status);

    const text = await readBoundedText(response);
    let body: unknown;
    try {
      body = text === null ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    const parsed = queryResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new OneDollarStatsError(
        "onedollarstats_malformed_response",
        "OneDollarStats returned an unexpected response.",
      );
    }
    return parsed.data;
  }

  return { runQuery };
}
