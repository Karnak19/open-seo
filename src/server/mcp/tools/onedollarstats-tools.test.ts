import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";
import {
  getOneDollarStatsLandingPagesTool,
  getOneDollarStatsTrafficSourcesTool,
} from "./onedollarstats-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  runReport: vi.fn(),
  getOverview: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/onedollarstats/services/OneDollarStatsReportingService",
  () => ({
    OneDollarStatsReportingService: {
      runReport: mocks.runReport,
      getOverview: mocks.getOverview,
    },
  }),
);
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();
const page = { projectId: "project_1", limit: 100, offset: 0 };

describe("OneDollarStats MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({ id: "project_1" });
    mocks.runReport.mockResolvedValue({
      status: "ok",
      source: { provider: "onedollarstats", siteId: "example.com" },
      request: {
        reportKind: "channels",
        resolvedDateRange: { startDate: "2026-10-01", endDate: "2026-10-28" },
        channel: "all",
        dimensions: ["channel"],
        metrics: ["visits"],
      },
      rowCount: 1,
      rows: [{ channel: "Organic Search", visits: 9 }],
      pageInfo: { limit: 100, offset: 0, hasMore: false },
      warnings: [],
    });
  });

  it("maps the channel breakdown to the unfiltered channel report", async () => {
    const result = await getOneDollarStatsTrafficSourcesTool.handler(
      { ...page, breakdown: "channel", channel: "organic_search" },
      toolContext,
    );

    expect(mocks.runReport).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "channels" }),
    );
    expect(textContent(result)).toContain("Organic Search");
  });

  it("points connection problems at the project's integration settings", async () => {
    mocks.runReport.mockRejectedValue(
      new OneDollarStatsError(
        "onedollarstats_key_rejected",
        "OneDollarStats rejected the saved API key.",
      ),
    );

    const result = await getOneDollarStatsLandingPagesTool.handler(
      { ...page, channel: "organic_search" },
      toolContext,
    );

    expect(result.structuredContent).toMatchObject({
      status: "error",
      error: {
        code: "onedollarstats_key_rejected",
        actionUrl: "https://open-seo.test/p/project_1/settings/integrations",
      },
    });
  });
});
