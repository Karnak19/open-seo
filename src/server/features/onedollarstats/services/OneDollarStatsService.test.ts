import { symmetricEncrypt } from "better-auth/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";
import { OneDollarStatsService } from "./OneDollarStatsService";

const mocks = vi.hoisted(() => ({
  getInstance: vi.fn(),
  upsertInstance:
    vi.fn<
      (input: {
        organizationId: string;
        encryptedApiKey: string;
        savedByUserId: string;
      }) => Promise<unknown>
    >(),
  upsertConnection: vi.fn(),
  runQuery: vi.fn(),
  getOptionalEnvValue: vi.fn(),
}));

vi.mock(
  "@/server/features/onedollarstats/repositories/OneDollarStatsRepository",
  () => ({
    OneDollarStatsRepository: {
      getInstance: mocks.getInstance,
      upsertInstance: mocks.upsertInstance,
      upsertConnection: mocks.upsertConnection,
    },
  }),
);

vi.mock("@/server/lib/onedollarstatsClient", () => ({
  createOneDollarStatsClient: () => ({ runQuery: mocks.runQuery }),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: mocks.getOptionalEnvValue,
}));

const connect = (
  overrides: Partial<Parameters<typeof OneDollarStatsService.connect>[0]> = {},
) =>
  OneDollarStatsService.connect({
    projectId: "p1",
    organizationId: "org1",
    userId: "u1",
    apiKey: "ods_key_1",
    siteId: "example.com",
    timeZone: "Europe/Paris",
    ...overrides,
  });

describe("OneDollarStatsService.connect", () => {
  beforeEach(() => {
    mocks.getOptionalEnvValue.mockResolvedValue("a".repeat(32));
    mocks.getInstance.mockResolvedValue(null);
    mocks.runQuery.mockResolvedValue({ results: [] });
    mocks.upsertInstance.mockResolvedValue({
      id: "inst1",
      organizationId: "org1",
      encryptedApiKey: "sealed",
      savedByUserId: "u1",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    });
    mocks.upsertConnection.mockImplementation(
      async (input: { siteId: string }) => ({
        id: "c1",
        siteId: input.siteId,
      }),
    );
  });

  it("rejects a site that isn't a hostname before calling the API", async () => {
    const result = await connect({ siteId: "not a url://" });

    expect(result).toEqual({
      problem: {
        code: "validation_error",
        message: "Enter the site's hostname, like example.com.",
      },
    });
    expect(mocks.runQuery).not.toHaveBeenCalled();
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
  });

  it("turns a probe failure into a problem instead of storing anything", async () => {
    mocks.runQuery.mockRejectedValue(
      new OneDollarStatsError(
        "onedollarstats_key_rejected",
        "OneDollarStats rejected the saved API key.",
        401,
      ),
    );

    const result = await connect();

    expect(result).toEqual({
      problem: {
        code: "onedollarstats_key_rejected",
        message: "OneDollarStats rejected the saved API key.",
      },
    });
    expect(mocks.upsertInstance).not.toHaveBeenCalled();
    expect(mocks.upsertConnection).not.toHaveBeenCalled();
  });

  it("requires a key when the organization has none saved", async () => {
    const result = await connect({ apiKey: null });

    expect(result).toEqual({
      problem: {
        code: "validation_error",
        message: "Enter the OneDollarStats API key.",
      },
    });
  });

  it("stores one encrypted key per organization and the project's site", async () => {
    const result = await connect();

    expect(mocks.runQuery).toHaveBeenCalledWith(
      "example.com",
      expect.objectContaining({ dateRange: "7d" }),
    );
    expect(mocks.upsertInstance).toHaveBeenCalledTimes(1);
    expect(mocks.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        instanceId: "inst1",
        siteId: "example.com",
      }),
    );
    expect(result).toEqual({ siteId: "example.com" });
  });

  it("reuses the saved key for a second project and replaces it when given", async () => {
    mocks.getInstance.mockResolvedValue({
      id: "inst1",
      organizationId: "org1",
      encryptedApiKey: await symmetricEncrypt({
        key: "a".repeat(32),
        data: "ods_key_1",
      }),
    });

    await connect({ apiKey: null, projectId: "p2" });
    expect(mocks.upsertInstance).not.toHaveBeenCalled();
    expect(mocks.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p2", instanceId: "inst1" }),
    );

    await connect({ apiKey: "ods_key_2" });
    expect(mocks.upsertInstance).toHaveBeenCalledTimes(1);
    expect(typeof mocks.upsertInstance.mock.calls[0]?.[0].encryptedApiKey).toBe(
      "string",
    );
  });

  it("normalizes a pasted URL down to the bare hostname", async () => {
    await connect({ siteId: "https://www.example.com/pricing" });

    expect(mocks.runQuery).toHaveBeenCalledWith(
      "example.com",
      expect.anything(),
    );
  });
});
