import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OneDollarStatsQuery } from "@/server/lib/onedollarstatsClient";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";
import { OneDollarStatsReportingService } from "./OneDollarStatsReportingService";

type QueryResult = {
  results: Array<{
    metrics: Array<number | null>;
    dimensions?: Array<string | null>;
  }>;
};

const mocks = vi.hoisted(() => {
  // The connection the service opens; tests retarget the time zone.
  const connection = { siteId: "example.com", timeZone: "Europe/Paris" };
  const runQuery =
    vi.fn<
      (siteId: string, query: OneDollarStatsQuery) => Promise<QueryResult>
    >();
  return { connection, runQuery };
});

vi.mock("./OneDollarStatsService", () => ({
  OneDollarStatsService: {
    openConnection: async () => ({
      connection: mocks.connection,
      client: { runQuery: mocks.runQuery },
    }),
  },
}));

// 2026-10-25 12:00 UTC; Europe/Paris is on summer time (UTC+2), so its
// "today" is 2026-10-25 and its last complete day is 2026-10-24.
const NOW = new Date("2026-10-25T12:00:00Z");

function queryResult(
  rows: Array<{
    metrics: Array<number | null>;
    dimensions?: Array<string | null>;
  }>,
): QueryResult {
  return { results: rows };
}

const calls = () => mocks.runQuery.mock.calls;

describe("OneDollarStatsReportingService.getOverview", () => {
  beforeEach(() => {
    mocks.connection.timeZone = "Europe/Paris";
    mocks.runQuery.mockResolvedValue(queryResult([]));
  });

  it("reads the last 28 complete days against the 28 before, as whole UTC days", async () => {
    const overview = await OneDollarStatsReportingService.getOverview(
      { projectId: "p1", channel: "all" },
      { now: NOW },
    );

    expect(calls().map(([, query]) => query.dateRange)).toEqual([
      ["2026-09-27T00:00:00.000Z", "2026-10-24T23:59:59.999Z"],
      ["2026-08-30T00:00:00.000Z", "2026-09-26T23:59:59.999Z"],
      ["2026-09-27T00:00:00.000Z", "2026-10-24T23:59:59.999Z"],
    ]);
    expect(calls().every(([, query]) => !query.filters)).toBe(true);
    expect(overview.current).toEqual({
      visits: 0,
      visitors: 0,
      pageviews: 0,
      bounceRate: null,
      avgVisitDurationSeconds: null,
    });
  });

  it("groups organic totals by referrer and aggregates the search ones with visit-weighted rates", async () => {
    mocks.runQuery
      // Current: two search referrers, a social one and a direct row.
      .mockResolvedValueOnce(
        queryResult([
          {
            metrics: [90, 100, 250, 80, 100],
            dimensions: ["www.google.com"],
          },
          {
            metrics: [45, 50, 120, 60, 200],
            dimensions: ["duckduckgo.com"],
          },
          { metrics: [30, 30, 90, 90, 90], dimensions: ["t.co"] },
          { metrics: [20, 20, 40, 40, 40], dimensions: [null] },
        ]),
      )
      // Previous: one plain row.
      .mockResolvedValueOnce(
        queryResult([
          { metrics: [100, 130, 350, 50, 150], dimensions: ["www.google.com"] },
        ]),
      )
      // Trend: (day, referrer) rows for two days, including a non-search one.
      .mockResolvedValueOnce(
        queryResult([
          {
            metrics: [3, 2],
            dimensions: ["2026-10-23 00:00:00", "www.google.com"],
          },
          {
            metrics: [2, 2],
            dimensions: ["2026-10-23 00:00:00", "duckduckgo.com"],
          },
          {
            metrics: [99, 99],
            dimensions: ["2026-10-23 00:00:00", "t.co"],
          },
          {
            metrics: [5, 4],
            dimensions: ["2026-10-24 00:00:00", "www.google.com"],
          },
        ]),
      );

    const overview = await OneDollarStatsReportingService.getOverview(
      { projectId: "p1" },
      { now: NOW },
    );

    expect(calls()[0]?.[1].dimensions).toEqual(["visit:referrer"]);
    expect(calls()[0]?.[1].filters).toBeUndefined();
    expect(calls()[2]?.[1].dimensions).toEqual(["time:day", "visit:referrer"]);

    // Search rows only: counts sum; bounce 80%/60% over 100/50 visits ->
    // 73.33%; duration 100s/200s over the same weights -> 133.33s.
    expect(overview.current).toEqual({
      visits: 150,
      visitors: 135,
      pageviews: 370,
      bounceRate: 0.7333333333333333,
      avgVisitDurationSeconds: 133.33333333333334,
    });
    expect(overview.comparison.visits.percentChange).toBeCloseTo(
      (150 - 130) / 130,
    );
    // Days without traffic are zero-filled; the two search referrers on
    // 2026-10-23 sum to one bucket and the social one is left out.
    expect(overview.trend).toHaveLength(28);
    expect(overview.trend.at(-2)).toEqual({
      date: "2026-10-23",
      visits: 5,
      visitors: 4,
    });
    expect(overview.trend.at(-1)).toEqual({
      date: "2026-10-24",
      visits: 5,
      visitors: 4,
    });
    expect(overview.trend[0]).toEqual({
      date: "2026-09-27",
      visits: 0,
      visitors: 0,
    });
  });

  it("asks for a monthly trend when the range spans more than 180 days", async () => {
    const overview = await OneDollarStatsReportingService.getOverview(
      {
        projectId: "p1",
        channel: "all",
        startDate: "2025-10-01",
        endDate: "2026-10-01",
      },
      { now: NOW },
    );

    expect(calls()[2]?.[1].dimensions).toEqual(["time:month"]);
    expect(overview.request.trend).toBe("monthly");
  });

  it("rejects a start date without an end date", async () => {
    await expect(
      OneDollarStatsReportingService.getOverview({
        projectId: "p1",
        startDate: "2026-10-01",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });
});

describe("OneDollarStatsReportingService.runReport", () => {
  beforeEach(() => {
    mocks.connection.timeZone = "UTC";
    mocks.runQuery.mockResolvedValue(queryResult([]));
  });

  it("lists referrer sources with (direct) for the null referrer", async () => {
    mocks.runQuery.mockResolvedValue(
      queryResult([
        { metrics: [428, 325, 860], dimensions: ["www.google.com"] },
        { metrics: [129, 101, 300], dimensions: [null] },
      ]),
    );

    const report = await OneDollarStatsReportingService.runReport({
      projectId: "p1",
      kind: "sources",
      channel: "all",
    });

    expect(calls()[0]?.[1].dimensions).toEqual(["visit:referrer"]);
    expect(calls()[0]?.[1].filters).toBeUndefined();
    expect(report.rows).toEqual([
      { source: "www.google.com", visits: 428, visitors: 325, pageviews: 860 },
      { source: "(direct)", visits: 129, visitors: 101, pageviews: 300 },
    ]);
    expect(report.truncated).toBe(false);
  });

  it("rides the referrer along as a dimension and keeps only search rows for organic pages", async () => {
    mocks.runQuery.mockResolvedValue(
      queryResult([
        {
          metrics: [200, 150, 200],
          dimensions: ["/pricing", "www.google.com"],
        },
        {
          metrics: [100, 80, 100],
          dimensions: ["/pricing", "www.bing.com"],
        },
        {
          metrics: [80, 70, 80],
          dimensions: ["/pricing", "t.co"],
        },
        { metrics: [50, 40, 50], dimensions: ["/", "www.google.com"] },
      ]),
    );

    const report = await OneDollarStatsReportingService.runReport({
      projectId: "p1",
      kind: "pages",
      channel: "organic_search",
    });

    const query = calls()[0]?.[1];
    expect(query?.dimensions).toEqual(["event:page", "visit:referrer"]);
    expect(query?.filters).toBeUndefined();
    // The t.co pageviews stay out of the organic aggregation.
    expect(report.rows).toEqual([
      { pagePath: "/pricing", pageviews: 300, visitors: 230, visits: 300 },
      { pagePath: "/", pageviews: 50, visitors: 40, visits: 50 },
    ]);
    expect(report.request.channel).toBe("organic_search");
  });

  it("marks the report truncated when groups are cut by the limit", async () => {
    mocks.runQuery.mockResolvedValue(
      queryResult(
        Array.from({ length: 4 }, (_, index) => ({
          metrics: [index, index, index],
          dimensions: [`/page-${index}`],
        })),
      ),
    );

    const report = await OneDollarStatsReportingService.runReport({
      projectId: "p1",
      kind: "pages",
      channel: "all",
      limit: 3,
    });

    expect(report.rows).toHaveLength(3);
    expect(report.truncated).toBe(true);
  });

  it("rejects a limit out of bounds", async () => {
    await expect(
      OneDollarStatsReportingService.runReport({
        projectId: "p1",
        kind: "pages",
        limit: 0,
      }),
    ).rejects.toBeInstanceOf(OneDollarStatsError);
  });
});
