import { createExchange } from "@glowlabs-org/events-sdk";

type QueueBinding = {
  source?: string;
  routing_key?: string;
};

const DEFAULT_AMQP_HOST = "turntable.proxy.rlwy.net:50784";
const DEFAULT_TIMEOUT_MS = 10_000;
const EXPECTED_ZONE_EXCHANGES = [0, 1, 2, 3, 4].map(
  (zoneId) => `glow.zone-${zoneId}.events`
);

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseAmqpHostFromUrl(amqpUrl: string): string {
  const parsed = new URL(amqpUrl);
  if (!parsed.hostname || !parsed.port) {
    throw new Error(
      `RABBITMQ_URL must include hostname and port, received: ${amqpUrl}`
    );
  }
  return `${parsed.hostname}:${parsed.port}`;
}

function resolveAmqpConfig(): { username: string; password: string; host: string } {
  const amqpUrl = process.env.RABBITMQ_URL?.trim();
  const parsed = amqpUrl ? new URL(amqpUrl) : null;

  const username =
    process.env.RABBITMQ_ADMIN_USER?.trim() ||
    (parsed?.username ? decodeURIComponent(parsed.username) : "");
  const password =
    process.env.RABBITMQ_ADMIN_PASSWORD?.trim() ||
    (parsed?.password ? decodeURIComponent(parsed.password) : "");
  const host =
    process.env.RABBITMQ_HOST?.trim() ||
    (amqpUrl ? parseAmqpHostFromUrl(amqpUrl) : DEFAULT_AMQP_HOST);

  if (!username || !password) {
    throw new Error(
      "Missing RabbitMQ credentials. Set RABBITMQ_ADMIN_USER/RABBITMQ_ADMIN_PASSWORD or RABBITMQ_URL."
    );
  }

  return { username, password, host };
}

function normalizeManagementUrl(rawUrl: string): string {
  return rawUrl.endsWith("/") ? rawUrl.slice(0, -1) : rawUrl;
}

async function fetchJsonWithBasicAuth<T>(
  url: string,
  username: string,
  password: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<{ status: number; json: T | null; rawText: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const authHeader = Buffer.from(`${username}:${password}`).toString("base64");
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${authHeader}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const rawText = await response.text();
    let json: T | null = null;
    if (rawText) {
      try {
        json = JSON.parse(rawText) as T;
      } catch {
        json = null;
      }
    }
    return { status: response.status, json, rawText };
  } finally {
    clearTimeout(timeout);
  }
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  const { username, password, host } = resolveAmqpConfig();
  const queueName = getRequiredEnv("RABBITMQ_QUEUE_NAME");

  const managementUrlRaw = getRequiredEnv("RABBITMQ_MANAGEMENT_URL");
  const managementUrl = normalizeManagementUrl(managementUrlRaw);
  const managementUser =
    process.env.RABBITMQ_MANAGEMENT_AUTH_USER?.trim() || username;
  const managementPass =
    process.env.RABBITMQ_MANAGEMENT_AUTH_PASSWORD?.trim() || password;

  // AMQP-level synthetic check: open channel and perform idempotent assert on a known exchange.
  await createExchange({
    username,
    password,
    host,
    exchange: EXPECTED_ZONE_EXCHANGES[0],
  });

  const queueUrl = `${managementUrl}/api/queues/%2F/${encodeURIComponent(queueName)}`;
  const queueResp = await fetchJsonWithBasicAuth<Record<string, unknown>>(
    queueUrl,
    managementUser,
    managementPass
  );

  if (queueResp.status !== 200) {
    throw new Error(
      `Queue check failed for '${queueName}' (status ${queueResp.status}): ${queueResp.rawText || "empty response"}`
    );
  }

  const bindingsUrl = `${managementUrl}/api/queues/%2F/${encodeURIComponent(queueName)}/bindings`;
  const bindingsResp = await fetchJsonWithBasicAuth<QueueBinding[]>(
    bindingsUrl,
    managementUser,
    managementPass
  );

  if (bindingsResp.status !== 200 || !Array.isArray(bindingsResp.json)) {
    throw new Error(
      `Bindings check failed for '${queueName}' (status ${bindingsResp.status}): ${bindingsResp.rawText || "empty response"}`
    );
  }

  const missingExchanges = EXPECTED_ZONE_EXCHANGES.filter(
    (exchange) =>
      !bindingsResp.json!.some(
        (binding) =>
          binding.source === exchange &&
          (binding.routing_key || "") === "#"
      )
  );

  if (missingExchanges.length > 0) {
    throw new Error(
      `Queue '${queueName}' is missing expected bindings: ${missingExchanges.join(", ")}`
    );
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    JSON.stringify(
      {
        status: "ok",
        host,
        queueName,
        managementUrl,
        checkedExchanges: EXPECTED_ZONE_EXCHANGES,
        durationMs,
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  const message =
    error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
  console.error("[rabbitmq-monitor] FAILED:", message);
  process.exit(1);
});
