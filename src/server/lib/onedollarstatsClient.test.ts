import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOneDollarStatsClient } from "./onedollarstatsClient";
import type { OneDollarStatsQuery } from "./onedollarstatsClient";
import { OneDollarStatsError } from "./onedollarstatsErrors";

// The client always calls fetch with a plain URL and a JSON body, so the mock
// types exactly that shape instead of the full RequestInfo union.
const mocks = vi.hoisted(() => ({
  fetch: vi.fn<
    (
      url: string,
      init?: {
        method: string;
        headers: Record<string, string>;
        body: string;
      },
    ) => Promise<Response>
  >(),
}));

/** Rethrows anything that isn't the typed error the test is asserting on. */
function asOneDollarStatsError(caught: unknown): OneDollarStatsError {
  if (!(caught instanceof OneDollarStatsError)) throw caught;
  return caught;
}

const query: OneDollarStatsQuery = { metrics: ["visits"], dateRange: "7d" };

describe("createOneDollarStatsClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("sends the query as a stats-API request with the key header", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({
        results: [{ metrics: [12, 34], dimensions: ["/pricing"] }],
      }),
    );
    const client = createOneDollarStatsClient({ apiKey: "ods_key_1" });

    await client.runQuery("example.com", {
      metrics: ["visitors", "visits"],
      dateRange: ["2026-09-27", "2026-10-24"],
      dimensions: ["event:page"],
      filters: [["is", "visit:channel", ["Organic Search"]]],
      orderBy: [["visits", "desc"]],
      limit: 101,
    });

    const request = mocks.fetch.mock.calls[0]?.[1];
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe(
      "https://api.onedollarstats.com/api",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers["x-api-key"]).toBe("ods_key_1");
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      site_id: "example.com",
      metrics: ["visitors", "visits"],
      date_range: ["2026-09-27", "2026-10-24"],
      dimensions: ["event:page"],
      filters: [["is", "visit:channel", ["Organic Search"]]],
      order_by: [["visits", "desc"]],
      pagination: { limit: 101 },
    });
  });

  it("maps an invalid key, a blocked site and rate limiting to typed errors", async () => {
    const client = createOneDollarStatsClient({ apiKey: "ods_key_1" });

    for (const [status, code] of [
      [401, "onedollarstats_key_rejected"],
      [403, "onedollarstats_site_inaccessible"],
      [429, "onedollarstats_rate_limited"],
      [500, "onedollarstats_unreachable"],
    ] as const) {
      mocks.fetch.mockResolvedValue(
        new Response("boom", { status, statusText: "boom" }),
      );
      const error = asOneDollarStatsError(
        await client.runQuery("example.com", query).catch((c: unknown) => c),
      );
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.message).not.toContain("ods_key_1");
    }
  });

  it("rejects a redirect and a non-JSON answer instead of trusting them", async () => {
    const client = createOneDollarStatsClient({ apiKey: "ods_key_1" });

    mocks.fetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "/login" } }),
    );
    await expect(client.runQuery("example.com", query)).rejects.toMatchObject({
      code: "onedollarstats_unreachable",
      status: 302,
    });

    mocks.fetch.mockResolvedValue(
      new Response("<html>login page</html>", {
        headers: { "content-type": "text/html" },
      }),
    );
    await expect(client.runQuery("example.com", query)).rejects.toMatchObject({
      code: "onedollarstats_malformed_response",
    });
  });

  it("keeps null metric and dimension values instead of failing on them", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({
        results: [{ metrics: [5, null], dimensions: [null] }],
      }),
    );
    const client = createOneDollarStatsClient({ apiKey: "ods_key_1" });

    const result = await client.runQuery("example.com", {
      metrics: ["visits", "bounce_rate"],
      dateRange: "7d",
      dimensions: ["visit:referrer"],
    });

    expect(result.results[0]?.metrics).toEqual([5, null]);
    expect(result.results[0]?.dimensions).toEqual([null]);
  });
});
