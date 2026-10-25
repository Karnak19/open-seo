import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import {
  OneDollarStatsRepository,
  type OneDollarStatsInstance,
} from "@/server/features/onedollarstats/repositories/OneDollarStatsRepository";
import { AppError } from "@/server/lib/errors";
import { createOneDollarStatsClient } from "@/server/lib/onedollarstatsClient";
import { OneDollarStatsError } from "@/server/lib/onedollarstatsErrors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { safeHostname } from "@/shared/safe-url";
import { MIN_BETTER_AUTH_SECRET_LENGTH } from "@/shared/selfhost-checks";

// The same secret that encrypts the Google OAuth tokens. Every deployment
// mode that stores integration credentials already sets it.
async function getEncryptionKey(): Promise<string | null> {
  const secret = (await getOptionalEnvValue("BETTER_AUTH_SECRET"))?.trim();
  return secret && secret.length >= MIN_BETTER_AUTH_SECRET_LENGTH
    ? secret
    : null;
}

async function requireEncryptionKey(): Promise<string> {
  const key = await getEncryptionKey();
  if (!key) {
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      `Set BETTER_AUTH_SECRET to at least ${MIN_BETTER_AUTH_SECRET_LENGTH} characters to store the OneDollarStats API key. It encrypts it.`,
    );
  }
  return key;
}

async function isEncryptionConfigured(): Promise<boolean> {
  return (await getEncryptionKey()) !== null;
}

/** Decrypts in memory only. The result must never be persisted or logged. */
async function openApiKey(instance: OneDollarStatsInstance): Promise<string> {
  const key = await requireEncryptionKey();
  try {
    return await symmetricDecrypt({ key, data: instance.encryptedApiKey });
  } catch {
    // A rotated BETTER_AUTH_SECRET makes the stored key unreadable.
    throw new OneDollarStatsError(
      "onedollarstats_key_rejected",
      "The saved OneDollarStats API key can no longer be read. Add it again.",
    );
  }
}

type Problem = {
  problem: { code: OneDollarStatsError["code"]; message: string };
};

function asProblem(error: unknown): Problem {
  if (error instanceof OneDollarStatsError) {
    return { problem: { code: error.code, message: error.message } };
  }
  throw error;
}

/** OneDollarStats keys queries on the bare hostname, e.g. "example.com". */
function normalizeSiteId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  return safeHostname(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
}

async function getConnection(projectId: string) {
  return OneDollarStatsRepository.getConnectionWithInstance(projectId);
}

/** Whether the organization already saved an API key, so a second project can
 *  connect with just its hostname. */
async function hasApiKey(organizationId: string): Promise<boolean> {
  return (await OneDollarStatsRepository.getInstance(organizationId)) !== null;
}

/**
 * Connects a project to one OneDollarStats site. A one-week probe query proves
 * the key and the site work before anything is stored, so a broken combination
 * fails here instead of on the dashboard. Omitting the key reuses the one
 * already saved for the organization.
 */
async function connect(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  apiKey: string | null;
  siteId: string;
  timeZone: string;
}): Promise<{ siteId: string } | Problem> {
  const key = await requireEncryptionKey();
  const siteId = normalizeSiteId(input.siteId);
  if (!siteId) {
    return {
      problem: {
        code: "validation_error",
        message: "Enter the site's hostname, like example.com.",
      },
    };
  }

  const instance = await OneDollarStatsRepository.getInstance(
    input.organizationId,
  );
  let apiKey: string;
  if (input.apiKey) {
    apiKey = input.apiKey;
  } else if (instance) {
    apiKey = await openApiKey(instance);
  } else {
    return {
      problem: {
        code: "validation_error",
        message: "Enter the OneDollarStats API key.",
      },
    };
  }

  try {
    await createOneDollarStatsClient({ apiKey }).runQuery(siteId, {
      metrics: ["visitors"],
      dateRange: "7d",
    });
  } catch (error) {
    return asProblem(error);
  }

  let stored = instance;
  if (input.apiKey) {
    stored = await OneDollarStatsRepository.upsertInstance({
      organizationId: input.organizationId,
      encryptedApiKey: await symmetricEncrypt({ key, data: input.apiKey }),
      savedByUserId: input.userId,
    });
  }
  if (!stored) throw new AppError("INTERNAL_ERROR");
  const connection = await OneDollarStatsRepository.upsertConnection({
    projectId: input.projectId,
    organizationId: input.organizationId,
    instanceId: stored.id,
    siteId,
    timeZone: input.timeZone,
    connectedByUserId: input.userId,
  });
  return { siteId: connection.siteId };
}

/** The project's connection plus a ready client, for reports. */
async function openConnection(projectId: string) {
  const row =
    await OneDollarStatsRepository.getConnectionWithInstance(projectId);
  if (!row) {
    throw new OneDollarStatsError(
      "onedollarstats_not_connected",
      "OneDollarStats is not connected for this project.",
    );
  }
  return {
    connection: row.connection,
    instance: row.instance,
    client: createOneDollarStatsClient({
      apiKey: await openApiKey(row.instance),
    }),
  };
}

async function disconnect(projectId: string): Promise<void> {
  await OneDollarStatsRepository.deleteConnection(projectId);
}

export const OneDollarStatsService = {
  isEncryptionConfigured,
  getConnection,
  hasApiKey,
  connect,
  openConnection,
  disconnect,
};
