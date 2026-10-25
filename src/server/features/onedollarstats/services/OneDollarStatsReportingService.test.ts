import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OneDollarStatsQuery } from "@/server/lib/onedollarstatsClient";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";
import { OneDollarStatsReportingService } from "./OneDollarStatsReportingService";

type QueryResult = {
  results: Array<{ metrics: Array<number | null>; dimensions?: string[] }>;
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
  rows: Array<{ metrics: Array<number | null>; dimensions?: string[] }>,
): QueryResult {
  return { results: rows };
}

const calls = () => mocks.runQuery.mock.calls;

describe("OneDollarStatsReportingService.getOverview", () => {
  beforeEach(() => {
    mocks.connection.timeZone = "Europe/Paris";
    mocks.runQuery.mockResolvedValue(queryResult([]));
  });

  it("reads the last 28 complete days against the 28 before, filtered to organic", async () => {
    mocks.runQuery
      .mockResolvedValueOnce(
        queryResult([{ metrics: [120, 150, 400, 94, 194] }]),
      )
      .mockResolvedValueOnce(
        queryResult([{ metrics: [100, 130, 350, 80, 170] }]),
      )
      .mockResolvedValueOnce(
        queryResult([
          { metrics: [3, 2], dimensions: ["2026-10-23T00:00:00Z"] },
          { metrics: [5, 4], dimensions: ["2026-10-24T00:00:00Z"] },
        ]),
      );

    const overview = await OneDollarStatsReportingService.getOverview(
      { projectId: "p1" },
      { now: NOW },
    );

    const organicFilter = [["is", "visit:channel", ["Organic Search"]]];
    expect(calls().map(([, query]) => query.dateRange)).toEqual([
      ["2026-09-27", "2026-10-24"],
      ["2026-08-30", "2026-09-26"],
      ["2026-09-27", "2026-10-24"],
    ]);
    expect(calls().map(([, query]) => query.filters ?? [])).toEqual([
      organicFilter,
      organicFilter,
      organicFilter,
    ]);

    expect(overview.current).toEqual({
      visits: 150,
      visitors: 120,
      pageviews: 400,
      bounceRate: 0.94,
      avgVisitDurationSeconds: 194,
    });
    expect(overview.comparison.visits.percentChange).toBeCloseTo(
      (150 - 130) / 130,
    );
    // 2026-09-27 through 2026-10-24, zero-filled around the two reported days.
    expect(overview.trend).toHaveLength(28);
    expect(overview.trend.at(-1)).toEqual({
      date: "2026-10-24",
      visits: 5,
      visitors: 4,
    });
    expect(overview.trend.at(-2)).toEqual({
      date: "2026-10-23",
      visits: 3,
      visitors: 2,
    });
    expect(overview.trend[0]).toEqual({
      date: "2026-09-27",
      visits: 0,
      visitors: 0,
    });
  });

  it("reports zeros for a period with no traffic, keeping rates null", async () => {
    const overview = await OneDollarStatsReportingService.getOverview(
      { projectId: "p1" },
      { now: NOW },
    );

    expect(overview.current).toEqual({
      visits: 0,
      visitors: 0,
      pageviews: 0,
      bounceRate: null,
      avgVisitDurationSeconds: null,
    });
  });

  it("asks for a monthly trend when the range spans more than 180 days", async () => {
    const overview = await OneDollarStatsReportingService.getOverview(
      { projectId: "p1", startDate: "2025-10-01", endDate: "2026-10-01" },
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

  it("maps landing pages with the organic filter and pages without it", async () => {
    mocks.runQuery.mockResolvedValue(
      queryResult([
        { metrics: [10, 7], dimensions: ["/pricing"] },
        { metrics: [4, 3], dimensions: ["/"] },
      ]),
    );

    const report = await OneDollarStatsReportingService.runReport({
      projectId: "p1",
      kind: "landing_pages",
    });

    const landingQuery = calls()[0]?.[1];
    expect(calls()[0]?.[0]).toBe("example.com");
    expect(landingQuery?.dimensions).toEqual(["visit:entry_page"]);
    expect(landingQuery?.filters).toEqual([
      ["is", "visit:channel", ["Organic Search"]],
    ]);
    expect(landingQuery?.limit).toBe(101);
    expect(report.rows).toEqual([
      { entryPage: "/pricing", visits: 10, visitors: 7 },
      { entryPage: "/", visits: 4, visitors: 3 },
    ]);
    expect(report.pageInfo.hasMore).toBe(false);

    await OneDollarStatsReportingService.runReport({
      projectId: "p1",
      kind: "page_performance",
      channel: "organic_search",
    });
    expect(calls()[1]?.[1].filters).toEqual([]);
  });

  it("detects another page beyond the requested page of rows", async () => {
    mocks.runQuery.mockResolvedValue(
      queryResult(
        Array.from({ length: 4 }, (_, index) => ({
          metrics: [index, index],
          dimensions: [`/page-${index}`],
        })),
      ),
    );

    const report = await OneDollarStatsReportingService.runReport({
      projectId: "p1",
      kind: "landing_pages",
      limit: 3,
    });

    expect(report.rows).toHaveLength(3);
    expect(report.pageInfo.hasMore).toBe(true);
  });

  it("rejects a limit out of bounds", async () => {
    await expect(
      OneDollarStatsReportingService.runReport({
        projectId: "p1",
        kind: "channels",
        limit: 0,
      }),
    ).rejects.toBeInstanceOf(OneDollarStatsError);
  });
});
