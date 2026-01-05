/**
 * Debug script: measure end-to-end latency for `/impact/glow-score` list mode.
 *
 * Usage:
 *   bun run scripts/debug-impact-leaderboard.ts --limit 50 --warmup 1 --repeat 3
 *   bun run scripts/debug-impact-leaderboard.ts --baseUrl http://localhost:3005 --limit 200 --repeat 5
 *
 * Tip:
 *   Pass `--debugTimings true` (default) to make the server print a single timing summary log per request.
 */

interface Args {
  baseUrl: string;
  limit: number;
  startWeek?: number;
  endWeek?: number;
  warmup: number;
  repeat: number;
  debugTimings: boolean;
}

function getArgValue(argv: string[], key: string): string | undefined {
  const idx = argv.indexOf(key);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.trunc(n);
}

function parseOptionalBool(value: string | undefined, defaultValue: boolean) {
  if (value == null) return defaultValue;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return defaultValue;
}

function parseArgs(argv: string[]): Args {
  const baseUrl = getArgValue(argv, "--baseUrl") ?? "http://localhost:3005";
  const limit = parseOptionalInt(getArgValue(argv, "--limit")) ?? 50;
  const startWeek = parseOptionalInt(getArgValue(argv, "--startWeek"));
  const endWeek = parseOptionalInt(getArgValue(argv, "--endWeek"));
  const warmup = parseOptionalInt(getArgValue(argv, "--warmup")) ?? 1;
  const repeat = parseOptionalInt(getArgValue(argv, "--repeat")) ?? 3;
  const debugTimings = parseOptionalBool(
    getArgValue(argv, "--debugTimings"),
    true
  );

  if (!Number.isFinite(limit) || limit <= 0) throw new Error("Invalid --limit");
  if (!Number.isFinite(warmup) || warmup < 0)
    throw new Error("Invalid --warmup");
  if (!Number.isFinite(repeat) || repeat <= 0)
    throw new Error("Invalid --repeat");

  return { baseUrl, limit, startWeek, endWeek, warmup, repeat, debugTimings };
}

function nowMs(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

async function withTimeout<T>(
  label: string,
  ms: number,
  promise: Promise<T>
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      }),
    ])) as T;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx]!;
}

async function requestOnce(params: Args): Promise<{
  ms: number;
  status: number;
  walletsReturned?: number;
  totalWalletCount?: number;
  weekRange?: { startWeek: number; endWeek: number };
}> {
  const url = new URL("/impact/glow-score", params.baseUrl);
  url.searchParams.set("limit", String(params.limit));
  if (params.startWeek != null) url.searchParams.set("startWeek", String(params.startWeek));
  if (params.endWeek != null) url.searchParams.set("endWeek", String(params.endWeek));
  if (params.debugTimings) url.searchParams.set("debugTimings", "true");

  const start = nowMs();
  const res = await withTimeout(
    "fetch /impact/glow-score",
    120_000,
    fetch(url, { cache: "no-store" })
  );
  const text = await res.text().catch(() => "");
  const ms = nowMs() - start;

  if (!res.ok) {
    return { ms, status: res.status };
  }

  try {
    const json = JSON.parse(text) as any;
    const walletsReturned = Array.isArray(json?.wallets) ? json.wallets.length : undefined;
    const totalWalletCount =
      typeof json?.totalWalletCount === "number" ? json.totalWalletCount : undefined;
    const weekRange =
      json?.weekRange &&
      typeof json.weekRange.startWeek === "number" &&
      typeof json.weekRange.endWeek === "number"
        ? { startWeek: json.weekRange.startWeek, endWeek: json.weekRange.endWeek }
        : undefined;

    return { ms, status: res.status, walletsReturned, totalWalletCount, weekRange };
  } catch {
    return { ms, status: res.status };
  }
}

async function main() {
  const args = parseArgs(process.argv);

  console.log("baseUrl:", args.baseUrl);
  console.log("limit:", args.limit);
  if (args.startWeek != null) console.log("startWeek:", args.startWeek);
  if (args.endWeek != null) console.log("endWeek:", args.endWeek);
  console.log("debugTimings:", args.debugTimings);
  console.log("warmup:", args.warmup);
  console.log("repeat:", args.repeat);
  console.log("");

  for (let i = 0; i < args.warmup; i++) {
    const r = await requestOnce(args);
    console.log(
      `[warmup ${i + 1}/${args.warmup}] status=${r.status} ms=${Math.round(r.ms * 10) / 10}`
    );
  }

  console.log("");

  const samples: number[] = [];
  let lastMeta:
    | {
        walletsReturned?: number;
        totalWalletCount?: number;
        weekRange?: { startWeek: number; endWeek: number };
      }
    | undefined;

  for (let i = 0; i < args.repeat; i++) {
    const r = await requestOnce(args);
    samples.push(r.ms);
    lastMeta = {
      walletsReturned: r.walletsReturned,
      totalWalletCount: r.totalWalletCount,
      weekRange: r.weekRange,
    };
    console.log(
      `[run ${i + 1}/${args.repeat}] status=${r.status} ms=${Math.round(r.ms * 10) / 10} wallets=${r.walletsReturned ?? "?"}`
    );
  }

  const sorted = samples.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const min = sorted[0] ?? 0;
  const max = sorted[sorted.length - 1] ?? 0;

  console.log("");
  console.log("summary:");
  console.log(
    JSON.stringify(
      {
        ...args,
        weekRange: lastMeta?.weekRange,
        walletsReturned: lastMeta?.walletsReturned,
        totalWalletCount: lastMeta?.totalWalletCount,
        ms: {
          min: Math.round(min * 10) / 10,
          p50: Math.round(p50 * 10) / 10,
          p95: Math.round(p95 * 10) / 10,
          max: Math.round(max * 10) / 10,
        },
      },
      null,
      2
    )
  );
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error("debug-impact-leaderboard FAILED");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
})();


