import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";
import {
  getOneDollarStatsPagePerformanceTool,
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
const page = { projectId: "project_1", limit: 100 };

describe("OneDollarStats MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({ id: "project_1" });
    mocks.runReport.mockResolvedValue({
      status: "ok",
      source: { provider: "onedollarstats", siteId: "example.com" },
      request: {
        reportKind: "sources",
        resolvedDateRange: { startDate: "2026-10-01", endDate: "2026-10-28" },
        channel: "all",
        dimensions: ["source"],
        metrics: ["visits"],
      },
      rowCount: 1,
      rows: [{ source: "www.google.com", visits: 9 }],
      truncated: false,
      warnings: [],
    });
  });

  it("maps the UTM breakdown to the sources report over the referrer dimension", async () => {
    const result = await getOneDollarStatsTrafficSourcesTool.handler(
      { ...page, breakdown: "utm_source", channel: "organic_search" },
      toolContext,
    );

    expect(mocks.runReport).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "sources",
        breakdown: "utm_source",
      }),
    );
    expect(textContent(result)).toContain("www.google.com");
  });

  it("points connection problems at the project's integration settings", async () => {
    mocks.runReport.mockRejectedValue(
      new OneDollarStatsError(
        "onedollarstats_site_inaccessible",
        "OneDollarStats denied access to this site.",
      ),
    );

    const result = await getOneDollarStatsPagePerformanceTool.handler(
      { ...page, channel: "all" },
      toolContext,
    );

    expect(result.structuredContent).toMatchObject({
      status: "error",
      error: {
        code: "onedollarstats_site_inaccessible",
        actionUrl: "https://open-seo.test/p/project_1/settings/integrations",
      },
    });
  });
});
