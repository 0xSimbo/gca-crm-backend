import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "../../../db/db";
import {
  controlRegionRewardsWeek,
  controlWalletStakeByEpoch,
} from "../../../db/schema";
import { getCurrentEpoch } from "../../../utils/getProtocolWeek";
import { getWeekRange } from "../../fractions-router/helpers/apy-helpers";

export interface ControlApiFarmReward {
  weekNumber: number;
  farmId: string;
  farmName?: string;
  regionId?: number;
  builtAt?: string;
  builtEpoch?: number;
  asset?: string | null;
  expectedWeeklyCarbonCredits?: string;
  protocolDepositUSDC6Decimals?: string;
  walletTotalGlowInflationReward?: string;
  walletTotalProtocolDepositReward?: string;
  walletInflationFromLaunchpad?: string;
  walletInflationFromMiningCenter?: string;
  walletProtocolDepositFromLaunchpad?: string;
  walletProtocolDepositFromMiningCenter?: string;
  farmTotalInflation?: string;
  farmTotalProtocolDepositReward?: string;
}

export interface ControlApiDepositSplitHistorySegment {
  farmId: string;
  startWeek: number;
  endWeek: number;
  depositSplitPercent6Decimals: string;
}

export interface ControlApiBatchDepositSplitsHistoryResponse {
  results?: Record<string, ControlApiDepositSplitHistorySegment[]>;
  error?: string;
}

export interface ControlApiFarmRewardsHistoryRewardRow {
  weekNumber: number;
  paymentCurrency: string;
  protocolDepositRewardsDistributed: string;
}

export interface ControlApiFarmRewardsHistoryFarmResult {
  rewards?: ControlApiFarmRewardsHistoryRewardRow[];
  error?: string;
}

export interface ControlApiBatchFarmRewardsHistoryResponse {
  results?: Record<string, ControlApiFarmRewardsHistoryFarmResult>;
  error?: string;
}

export interface ControlApiBatchWalletRewardsResponse {
  results?: Record<
    string,
    {
      farmRewards?: ControlApiFarmReward[];
      error?: string;
    }
  >;
}

export interface ControlApiWalletWeeklyRewardRow {
  weekNumber: number;
  paymentCurrency?: string | null;
  protocolDepositRewardsReceived?: string;
  glowInflationTotal?: string;
}

export interface UnclaimedGlwRewardsResult {
  amountWei: bigint;
  dataSource: "claims-api+control-api";
}

export interface SteeringByWeekResult {
  byWeek: Map<number, bigint>;
  byWeekAndRegion?: Map<number, Map<number, bigint>>;
  dataSource: "control-api";
  /**
   * True when we had to fall back to zero-values due to a downstream failure.
   * (We still report `dataSource: "control-api"` because this data is supposed to come from Control API.)
   */
  isFallback?: boolean;
  /**
   * Populated when `isFallback` is true.
   */
  error?: string;
}

export interface SteeringSnapshot {
  steeredGlwWeiPerWeek: bigint;
  hasSteeringStake: boolean;
  byRegion?: Map<number, bigint>;
}

function getControlApiUrl(): string {
  if (!process.env.CONTROL_API_URL) {
    throw new Error("CONTROL_API_URL not configured");
  }
  return process.env.CONTROL_API_URL;
}

const CLAIMS_API_BASE_URL =
  "https://glow-ponder-listener-2-production.up.railway.app";

function getPonderListenerBaseUrl(): string {
  return CLAIMS_API_BASE_URL;
}

const RETRYABLE_CONTROL_API_STATUSES = new Set([429, 500, 502, 503, 504]);
const CONTROL_API_BASE_RETRY_DELAY_MS = 300;
const CONTROL_API_WEEK_WINDOW_SIZE = 5;
const CONTROL_API_WEEK_WINDOW_CONCURRENCY = 2;
const CONTROL_API_MIN_WALLET_SPLIT_SIZE = 25;
const CONTROL_API_MIN_FARM_SPLIT_SIZE = 25;
const CONTROL_API_MAX_RECURSION_DEPTH = 4;
const CONTROL_API_SINGLE_ENDPOINT_MAX_ATTEMPTS = 4;
const CONTROL_API_EPOCH_REWARDS_TTL_CURRENT_MS = 30_000;
const CONTROL_API_EPOCH_REWARDS_TTL_FINALIZED_MS = 10 * 60_000;
const CONTROL_API_WALLET_STAKE_TTL_CURRENT_MS = 30_000;
const CONTROL_API_WALLET_STAKE_TTL_FINALIZED_MS = 5 * 60_000;
const CONTROL_API_FARM_REWARDS_TTL_CURRENT_MS = 30_000;
const CONTROL_API_FARM_REWARDS_TTL_FINALIZED_MS = 24 * 60 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getControlApiRetryDelayMs(attempt: number): number {
  const jitterMs = Math.floor(Math.random() * 150);
  return CONTROL_API_BASE_RETRY_DELAY_MS * 2 ** attempt + jitterMs;
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error == null) return null;
  const maybeStatus = (error as { status?: unknown }).status;
  if (typeof maybeStatus !== "number" || !Number.isFinite(maybeStatus))
    return null;
  return maybeStatus;
}

function isRetryableControlApiError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return (
    (status != null && RETRYABLE_CONTROL_API_STATUSES.has(status)) ||
    status == null
  );
}

function makeControlApiError(message: string, status: number): Error {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
}

function isUndefinedTableError(error: unknown): boolean {
  if (typeof error !== "object" || error == null) return false;
  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === "42P01";
}

function chunkWeekRange(
  startWeek: number,
  endWeek: number,
  windowSize: number
): Array<{ startWeek: number; endWeek: number }> {
  const windows: Array<{ startWeek: number; endWeek: number }> = [];
  for (let week = startWeek; week <= endWeek; week += windowSize) {
    windows.push({
      startWeek: week,
      endWeek: Math.min(endWeek, week + windowSize - 1),
    });
  }
  return windows;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({
    length: Math.max(1, Math.min(concurrency, items.length)),
  }).map(async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const cachedFarmRewardsByFarmWeek = new Map<
  string,
  {
    rows: ControlApiFarmRewardsHistoryRewardRow[];
    expiresAtMs: number;
  }
>();
const inFlightFarmRewardsBatches = new Map<
  string,
  Promise<Map<string, ControlApiFarmRewardsHistoryRewardRow[]>>
>();

function makeFarmRewardsWeekCacheKey(farmId: string, week: number): string {
  return `${farmId}|${week}`;
}

function makeFarmRewardsBatchCacheKey(params: {
  farmIds: string[];
  startWeek: number;
  endWeek: number;
}): string {
  const farmIds = params.farmIds.slice().sort();
  return `${params.startWeek}|${params.endWeek}|${farmIds.join(",")}`;
}

function cloneFarmRewardsRows(
  rows: ControlApiFarmRewardsHistoryRewardRow[]
): ControlApiFarmRewardsHistoryRewardRow[] {
  return rows.map((row) => ({ ...row }));
}

interface GlwHolderRow {
  id: string;
  balance: string;
}

interface GlwHoldersPageResponse {
  data?: {
    // NOTE: This is not a typo. Ponder's generated GraphQL schema pluralizes
    // `glowBalances` as `glowBalancess` (double "s"). See `ponder-listener/generated/schema.graphql`.
    glowBalancess?: {
      items?: GlwHolderRow[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      totalCount?: number;
    };
  };
  errors?: Array<{ message?: string }>;
}

let cachedGlwHolders: {
  expiresAtMs: number;
  data: {
    holders: string[];
    topHoldersByBalance: string[];
    totalCount: number;
  };
} | null = null;

export async function fetchGlwHoldersFromPonder(params?: {
  ttlMs?: number;
}): Promise<{
  holders: string[];
  topHoldersByBalance: string[];
  totalCount: number;
}> {
  const ttlMs = params?.ttlMs ?? 10 * 60_000;
  const now = Date.now();
  if (cachedGlwHolders && now < cachedGlwHolders.expiresAtMs)
    return cachedGlwHolders.data;

  const baseUrl = getPonderListenerBaseUrl();
  const PAGE_SIZE = 500;

  const holders: string[] = [];
  const topHoldersByBalance: string[] = [];
  let totalCount = 0;
  let after: string | undefined;
  let seenTotalCount = false;

  const query = `
    query GlwHolders($where: glowBalancesFilter, $after: String, $limit: Int) {
      # NOTE: Not a typo: the list field is glowBalancess (double "s") in Ponder's schema.
      glowBalancess(
        where: $where
        orderBy: "balance"
        orderDirection: "desc"
        after: $after
        limit: $limit
      ) {
        items { id balance }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  `;

  try {
    for (;;) {
      const response = await fetch(`${baseUrl}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: {
            where: { balance_gt: "0" },
            after: after ?? null,
            limit: PAGE_SIZE,
          },
        }),
      });

      const text = await response.text().catch(() => "");
      if (!response.ok)
        throw new Error(
          `Ponder GraphQL holders failed (${response.status}): ${
            text || "<empty>"
          }`
        );

      let json: GlwHoldersPageResponse;
      try {
        json = JSON.parse(text) as GlwHoldersPageResponse;
      } catch {
        throw new Error(
          `Ponder GraphQL holders returned invalid JSON: ${text}`
        );
      }

      const errMsg = json.errors?.[0]?.message;
      if (errMsg) throw new Error(`Ponder GraphQL error: ${errMsg}`);

      const page = json.data?.glowBalancess;
      const items = page?.items || [];
      if (!seenTotalCount && typeof page?.totalCount === "number") {
        totalCount = page.totalCount;
        seenTotalCount = true;
      }

      for (const row of items) {
        const wallet = (row.id || "").toLowerCase();
        if (!wallet) continue;
        holders.push(wallet);
        if (topHoldersByBalance.length < 5000) topHoldersByBalance.push(wallet);
      }

      const hasNext = page?.pageInfo?.hasNextPage === true;
      const endCursor = page?.pageInfo?.endCursor || undefined;
      if (!hasNext || !endCursor) break;
      after = endCursor;
    }
  } catch (error) {
    // If ponder is down, fail closed (do not silently return empty eligibility).
    throw error instanceof Error
      ? error
      : new Error(`Ponder holders fetch failed: ${String(error)}`);
  }

  const data = {
    holders,
    topHoldersByBalance,
    totalCount: totalCount || holders.length,
  };
  cachedGlwHolders = { expiresAtMs: now + ttlMs, data };
  return data;
}

interface ControlStakersPageResponse {
  wallets?: string[];
  nextCursor?: string;
  totalCount?: number;
  error?: string;
}

let cachedGctlStakers: {
  expiresAtMs: number;
  data: { stakers: string[]; totalCount: number };
} | null = null;

export async function fetchGctlStakersFromControlApi(params?: {
  ttlMs?: number;
}): Promise<{ stakers: string[]; totalCount: number }> {
  const ttlMs = params?.ttlMs ?? 10 * 60_000;
  const now = Date.now();
  if (cachedGctlStakers && now < cachedGctlStakers.expiresAtMs)
    return cachedGctlStakers.data;

  const baseUrl = getControlApiUrl();
  const stakers: string[] = [];
  let totalCount = 0;
  let cursor: string | undefined;
  let seenTotal = false;

  try {
    for (let page = 0; page < 10_000; page++) {
      const url = new URL("/wallets/stakers", baseUrl);
      url.searchParams.set("limit", "2000");
      if (cursor) url.searchParams.set("cursor", cursor);

      const response = await fetch(url);
      const text = await response.text().catch(() => "");
      if (!response.ok)
        throw new Error(
          `Control API stakers failed (${response.status}): ${
            text || "<empty>"
          }`
        );

      let json: ControlStakersPageResponse;
      try {
        json = JSON.parse(text) as ControlStakersPageResponse;
      } catch {
        throw new Error(`Control API stakers returned invalid JSON: ${text}`);
      }

      if (json.error)
        throw new Error(`Control API stakers error: ${json.error}`);

      const pageWallets = (json.wallets || []).map((w) => w.toLowerCase());
      for (const w of pageWallets) if (w) stakers.push(w);

      if (!seenTotal && typeof json.totalCount === "number") {
        totalCount = json.totalCount;
        seenTotal = true;
      }

      if (!json.nextCursor) break;
      cursor = json.nextCursor;
    }
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error(`Control API stakers fetch failed: ${String(error)}`);
  }

  const data = { stakers, totalCount: totalCount || stakers.length };
  cachedGctlStakers = { expiresAtMs: now + ttlMs, data };
  return data;
}

export type GlwBalanceSnapshotSource = "snapshot" | "current" | "forward_fill";

export interface GlwBalanceSnapshotWeekRow {
  weekNumber: number;
  balanceWei: string;
  balanceGlw: string;
  source: GlwBalanceSnapshotSource;
}

interface GlwBalanceSnapshotByWeekResponse {
  indexingComplete?: boolean;
  weekRange?: { startWeek: number; endWeek: number };
  results?: Array<{
    wallet: string;
    weeks: GlwBalanceSnapshotWeekRow[];
  }>;
  error?: string;
}

export async function fetchGlwBalanceSnapshotByWeekBatch(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, Map<number, { balanceWei: bigint; source: GlwBalanceSnapshotSource }>>> {
  const baseUrl = getPonderListenerBaseUrl();
  const wallets = params.wallets.map((w) => w.toLowerCase());

  const response = await fetch(`${baseUrl}/glow/balance-snapshot-by-week`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallets,
      startWeek: params.startWeek,
      endWeek: params.endWeek,
    }),
  });

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `Ponder listener balance snapshot failed (${response.status}): ${
        text || "<empty>"
      }`
    );
  }

  let data: GlwBalanceSnapshotByWeekResponse;
  try {
    data = JSON.parse(text) as GlwBalanceSnapshotByWeekResponse;
  } catch {
    throw new Error(
      `Ponder listener balance snapshot returned invalid JSON: ${text}`
    );
  }

  if (data.indexingComplete === false) {
    throw new Error(data.error || "Ponder listener is still indexing");
  }

  const result = new Map<
    string,
    Map<number, { balanceWei: bigint; source: GlwBalanceSnapshotSource }>
  >();
  for (const row of data.results || []) {
    const wallet = (row.wallet || "").toLowerCase();
    if (!wallet) continue;
    if (!result.has(wallet)) result.set(wallet, new Map());
    const byWeek = result.get(wallet)!;
    for (const w of row.weeks || []) {
      const weekNumber = Number(w.weekNumber);
      if (!Number.isFinite(weekNumber)) continue;
      try {
        byWeek.set(weekNumber, {
          balanceWei: BigInt(w.balanceWei || "0"),
          source: w.source,
        });
      } catch {
        byWeek.set(weekNumber, { balanceWei: BigInt(0), source: w.source });
      }
    }
  }
  return result;
}

export async function fetchGlwBalanceSnapshotByWeekMany(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
  batchSize?: number;
  concurrentBatches?: number;
}): Promise<
  Map<string, Map<number, { balanceWei: bigint; source: GlwBalanceSnapshotSource }>>
> {
  const {
    wallets,
    startWeek,
    endWeek,
    batchSize = 500,
    concurrentBatches = 3,
  } = params;
  const result = new Map<
    string,
    Map<number, { balanceWei: bigint; source: GlwBalanceSnapshotSource }>
  >();
  if (wallets.length === 0) return result;

  const normalizedWallets = Array.from(
    new Set(wallets.map((w) => w.toLowerCase()))
  );

  if (normalizedWallets.length <= batchSize) {
    return await fetchGlwBalanceSnapshotByWeekBatch({
      wallets: normalizedWallets,
      startWeek,
      endWeek,
    });
  }

  for (
    let i = 0;
    i < normalizedWallets.length;
    i += batchSize * concurrentBatches
  ) {
    const batchPromises: Array<
      Promise<
        Map<string, Map<number, { balanceWei: bigint; source: GlwBalanceSnapshotSource }>>
      >
    > = [];

    for (
      let j = 0;
      j < concurrentBatches && i + j * batchSize < normalizedWallets.length;
      j++
    ) {
      const batch = normalizedWallets.slice(
        i + j * batchSize,
        i + (j + 1) * batchSize
      );
      batchPromises.push(
        fetchGlwBalanceSnapshotByWeekBatch({
          wallets: batch,
          startWeek,
          endWeek,
        })
      );
    }

    const batchResults = await Promise.all(batchPromises);
    for (const batchMap of batchResults) {
      for (const [wallet, byWeek] of batchMap) {
        if (!result.has(wallet)) result.set(wallet, new Map());
        const acc = result.get(wallet)!;
        for (const [week, entry] of byWeek) acc.set(week, entry);
      }
    }
  }

  return result;
}

export interface NewGlwHoldersByWeekResponse {
  weekRange: { startWeek: number; endWeek: number };
  minBalanceGlw: string;
  byWeek: Record<number, number>;
  walletsByWeek?: Record<number, string[]>;
}

export async function fetchNewGlwHoldersByWeek(params: {
  startWeek: number;
  endWeek: number;
  minBalanceGlw?: string;
  includeWallets?: boolean;
}): Promise<NewGlwHoldersByWeekResponse> {
  const baseUrl = getPonderListenerBaseUrl();
  const payload = {
    startWeek: params.startWeek,
    endWeek: params.endWeek,
    minBalanceGlw: params.minBalanceGlw ?? "0.01",
    includeWallets: params.includeWallets ?? false,
  };

  const response = await fetch(`${baseUrl}/glow/new-holders-by-week`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `Ponder new holders by week failed (${response.status}): ${
        text || "<empty>"
      }`
    );
  }

  let data: NewGlwHoldersByWeekResponse;
  try {
    data = JSON.parse(text) as NewGlwHoldersByWeekResponse;
  } catch {
    throw new Error(
      `Ponder new holders by week returned invalid JSON: ${text}`
    );
  }

  return data;
}

export interface RegionRewardsResponse {
  totalGctlStaked: string;
  totalGlwRewards: string;
  regionRewards: Array<{
    regionId: number;
    gctlStaked: string;
    glwReward: string;
    rewardShare: string;
  }>;
}

interface WalletStakeByEpochResponse {
  wallet: string;
  weekRange: { startWeek: number; endWeek: number };
  results: Array<{
    epoch: number;
    regions: Array<{
      regionId: number;
      totalStaked: string;
      pendingUnstake: string;
      pendingRestakeOut: string;
      pendingRestakeIn: string;
    }>;
  }>;
}

let cachedRegionRewards: {
  data: RegionRewardsResponse;
  expiresAtMs: number;
} | null = null;

export async function getCachedRegionRewards(
  ttlMs = 30_000
): Promise<RegionRewardsResponse> {
  const now = Date.now();
  if (cachedRegionRewards && now < cachedRegionRewards.expiresAtMs) {
    return cachedRegionRewards.data;
  }

  const response = await fetch(`${getControlApiUrl()}/rewards/glw/regions`);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Control API region rewards failed (${response.status}): ${text}`
    );
  }
  const data = (await response.json()) as RegionRewardsResponse;
  cachedRegionRewards = { data, expiresAtMs: now + ttlMs };
  return data;
}

const MAINNET_GLOW_TOKEN =
  "0xf4fbc617a5733eaaf9af08e1ab816b103388d8b6" as const;

function safeBigInt(value: unknown): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(Math.trunc(value));
    if (typeof value === "string" && value.trim() !== "") return BigInt(value);
    return BigInt(0);
  } catch {
    return BigInt(0);
  }
}

function getV2WeekFromNonce(nonce: unknown): number | null {
  // Next.js app treats week 97 as v2 nonce 0.
  const FIRST_V2_WEEK = 97;
  const n = Number(nonce);
  if (!Number.isFinite(n) || n < 0) return null;
  const week = FIRST_V2_WEEK + Math.trunc(n);
  return week >= FIRST_V2_WEEK ? week : null;
}

export async function fetchWalletRewardsHistoryBatch(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, ControlApiFarmReward[]>> {
  const { startWeek, endWeek } = params;
  const normalizedWallets = Array.from(
    new Set(params.wallets.map((w) => w.toLowerCase()))
  );
  const result = new Map<string, ControlApiFarmReward[]>();
  if (normalizedWallets.length === 0) return result;

  const mergeMaps = (
    target: Map<string, ControlApiFarmReward[]>,
    source: Map<string, ControlApiFarmReward[]>
  ): void => {
    for (const [wallet, rows] of source) {
      if (!target.has(wallet)) target.set(wallet, []);
      target.get(wallet)!.push(...rows);
    }
  };

  const dedupeRows = (rows: ControlApiFarmReward[]): ControlApiFarmReward[] => {
    const seen = new Set<string>();
    const deduped: ControlApiFarmReward[] = [];
    for (const row of rows) {
      const key = [
        row.weekNumber,
        row.farmId,
        row.regionId ?? "",
        row.asset ?? "",
        row.walletTotalGlowInflationReward ?? "",
        row.walletTotalProtocolDepositReward ?? "",
        row.walletInflationFromLaunchpad ?? "",
        row.walletInflationFromMiningCenter ?? "",
        row.walletProtocolDepositFromLaunchpad ?? "",
        row.walletProtocolDepositFromMiningCenter ?? "",
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...row });
    }
    deduped.sort((a, b) => {
      const weekDiff = Number(a.weekNumber) - Number(b.weekNumber);
      if (weekDiff !== 0) return weekDiff;
      const farmDiff = (a.farmId || "").localeCompare(b.farmId || "");
      if (farmDiff !== 0) return farmDiff;
      return (a.asset || "").localeCompare(b.asset || "");
    });
    return deduped;
  };

  const fetchBatchOnce = async (
    wallets: string[],
    start: number,
    end: number
  ): Promise<Map<string, ControlApiFarmReward[]>> => {
    const response = await fetch(
      `${getControlApiUrl()}/farms/by-wallet/farm-rewards-history/batch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallets, startWeek: start, endWeek: end }),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw makeControlApiError(
        `Control API batch wallet rewards failed (${response.status}): ${text}`,
        response.status
      );
    }

    const data = (await response.json()) as ControlApiBatchWalletRewardsResponse;
    const rowsByWallet = data.results || {};
    const batchResult = new Map<string, ControlApiFarmReward[]>();
    for (const wallet of wallets) {
      const walletData = rowsByWallet[wallet] || rowsByWallet[wallet.toLowerCase()];
      if (!walletData?.farmRewards) continue;
      batchResult.set(wallet.toLowerCase(), walletData.farmRewards);
    }
    return batchResult;
  };

  const fetchBatchWithFallback = async (
    wallets: string[],
    start: number,
    end: number,
    depth = 0
  ): Promise<Map<string, ControlApiFarmReward[]>> => {
    const maxAttempts = wallets.length > 1 ? 3 : 4;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fetchBatchOnce(wallets, start, end);
      } catch (error) {
        lastError = error;
        if (!isRetryableControlApiError(error)) throw error;
        if (attempt >= maxAttempts - 1) break;
        await sleep(getControlApiRetryDelayMs(attempt));
      }
    }

    if (depth >= CONTROL_API_MAX_RECURSION_DEPTH) {
      throw lastError instanceof Error
        ? lastError
        : new Error("Control API batch wallet rewards failed");
    }

    const weekSpan = end - start + 1;
    if (weekSpan > CONTROL_API_WEEK_WINDOW_SIZE) {
      if (depth === 0) {
        const status = getErrorStatus(lastError);
        console.warn(
          `[control-api] retry exhausted for wallet rewards batch (wallets=${wallets.length}, startWeek=${start}, endWeek=${end}, status=${status ?? "unknown"}); retrying in ${CONTROL_API_WEEK_WINDOW_SIZE}-week windows`
        );
      }
      const windows = chunkWeekRange(start, end, CONTROL_API_WEEK_WINDOW_SIZE);
      const windowResults = await mapWithConcurrency(
        windows,
        CONTROL_API_WEEK_WINDOW_CONCURRENCY,
        async (window) =>
          await fetchBatchWithFallback(
            wallets,
            window.startWeek,
            window.endWeek,
            depth + 1
          )
      );
      const merged = new Map<string, ControlApiFarmReward[]>();
      for (const m of windowResults) mergeMaps(merged, m);
      return merged;
    }

    if (wallets.length > CONTROL_API_MIN_WALLET_SPLIT_SIZE) {
      if (depth === 0) {
        const status = getErrorStatus(lastError);
        console.warn(
          `[control-api] retry exhausted for wallet rewards batch (wallets=${wallets.length}, startWeek=${start}, endWeek=${end}, status=${status ?? "unknown"}); retrying in smaller wallet batches`
        );
      }
      const midpoint = Math.ceil(wallets.length / 2);
      const leftWallets = wallets.slice(0, midpoint);
      const rightWallets = wallets.slice(midpoint);
      if (leftWallets.length === 0 || rightWallets.length === 0) {
        throw lastError instanceof Error
          ? lastError
          : new Error("Control API batch wallet rewards failed");
      }
      const leftMap = await fetchBatchWithFallback(
        leftWallets,
        start,
        end,
        depth + 1
      );
      const rightMap = await fetchBatchWithFallback(
        rightWallets,
        start,
        end,
        depth + 1
      );
      const merged = new Map<string, ControlApiFarmReward[]>();
      mergeMaps(merged, leftMap);
      mergeMaps(merged, rightMap);
      return merged;
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Control API batch wallet rewards failed");
  };

  const fetched = await fetchBatchWithFallback(
    normalizedWallets,
    startWeek,
    endWeek
  );
  for (const [wallet, rows] of fetched) {
    result.set(wallet, dedupeRows(rows));
  }

  return result;
}

export async function fetchWalletWeeklyRewards(params: {
  walletAddress: string;
  paymentCurrency?: string;
  limit?: number;
  startWeek?: number;
  endWeek?: number;
}): Promise<ControlApiWalletWeeklyRewardRow[]> {
  const wallet = params.walletAddress.toLowerCase();
  const search = new URLSearchParams();
  if (params.paymentCurrency) search.set("paymentCurrency", params.paymentCurrency);
  if (params.limit != null && Number.isFinite(params.limit)) {
    search.set("limit", String(Math.max(1, Math.trunc(params.limit))));
  }
  const queryString = search.toString();
  const url = `${getControlApiUrl()}/wallets/address/${wallet}/weekly-rewards${
    queryString ? `?${queryString}` : ""
  }`;

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw makeControlApiError(
      `Control API wallet weekly rewards failed (${response.status}): ${text}`,
      response.status
    );
  }

  const data = (await response.json()) as {
    rewards?: Array<{
      weekNumber?: number;
      paymentCurrency?: string | null;
      protocolDepositRewardsReceived?: string;
      glowInflationTotal?: string;
    }>;
  };

  const rewards = Array.isArray(data?.rewards) ? data.rewards : [];
  const startWeek = params.startWeek;
  const endWeek = params.endWeek;
  const normalized: ControlApiWalletWeeklyRewardRow[] = [];
  for (const row of rewards) {
    const weekNumber = Number(row?.weekNumber);
    if (!Number.isFinite(weekNumber)) continue;
    if (startWeek != null && weekNumber < startWeek) continue;
    if (endWeek != null && weekNumber > endWeek) continue;
    normalized.push({
      weekNumber,
      paymentCurrency: row?.paymentCurrency ?? null,
      protocolDepositRewardsReceived: row?.protocolDepositRewardsReceived ?? "0",
      glowInflationTotal: row?.glowInflationTotal ?? "0",
    });
  }
  normalized.sort((a, b) => a.weekNumber - b.weekNumber);
  return normalized;
}

export async function fetchDepositSplitsHistoryBatch(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, ControlApiDepositSplitHistorySegment[]>> {
  const { startWeek, endWeek } = params;
  const result = new Map<string, ControlApiDepositSplitHistorySegment[]>();
  const normalizedWallets = Array.from(
    new Set(params.wallets.map((w) => w.toLowerCase()))
  );
  if (normalizedWallets.length === 0) return result;

  const mergeMaps = (
    target: Map<string, ControlApiDepositSplitHistorySegment[]>,
    source: Map<string, ControlApiDepositSplitHistorySegment[]>
  ): void => {
    for (const [wallet, rows] of source) {
      if (!target.has(wallet)) target.set(wallet, []);
      target.get(wallet)!.push(...rows);
    }
  };

  const compressSegments = (
    rows: ControlApiDepositSplitHistorySegment[]
  ): ControlApiDepositSplitHistorySegment[] => {
    const seen = new Set<string>();
    const deduped: ControlApiDepositSplitHistorySegment[] = [];
    for (const row of rows) {
      const key = [
        row.farmId,
        row.startWeek,
        row.endWeek,
        row.depositSplitPercent6Decimals,
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...row });
    }
    deduped.sort((a, b) => {
      const farmDiff = (a.farmId || "").localeCompare(b.farmId || "");
      if (farmDiff !== 0) return farmDiff;
      const startDiff = a.startWeek - b.startWeek;
      if (startDiff !== 0) return startDiff;
      return a.endWeek - b.endWeek;
    });
    const compressed: ControlApiDepositSplitHistorySegment[] = [];
    for (const row of deduped) {
      const prev = compressed[compressed.length - 1];
      if (
        prev &&
        prev.farmId === row.farmId &&
        prev.depositSplitPercent6Decimals === row.depositSplitPercent6Decimals &&
        prev.endWeek + 1 >= row.startWeek
      ) {
        if (row.endWeek > prev.endWeek) prev.endWeek = row.endWeek;
      } else {
        compressed.push({ ...row });
      }
    }
    return compressed;
  };

  const fetchBatchOnce = async (
    wallets: string[],
    start: number,
    end: number
  ): Promise<Map<string, ControlApiDepositSplitHistorySegment[]>> => {
    const response = await fetch(
      `${getControlApiUrl()}/farms/by-wallet/deposit-splits-history/batch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallets, startWeek: start, endWeek: end }),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw makeControlApiError(
        `Control API batch deposit splits history failed (${response.status}): ${text}`,
        response.status
      );
    }

    const data =
      (await response.json()) as ControlApiBatchDepositSplitsHistoryResponse;
    const rowsByWallet = data.results || {};
    const batchResult = new Map<string, ControlApiDepositSplitHistorySegment[]>();
    for (const wallet of wallets) {
      const rows = rowsByWallet[wallet] || rowsByWallet[wallet.toLowerCase()];
      if (!rows) continue;
      batchResult.set(wallet.toLowerCase(), rows);
    }
    return batchResult;
  };

  const fetchBatchWithFallback = async (
    wallets: string[],
    start: number,
    end: number,
    depth = 0
  ): Promise<Map<string, ControlApiDepositSplitHistorySegment[]>> => {
    const maxAttempts = wallets.length > 1 ? 3 : 4;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fetchBatchOnce(wallets, start, end);
      } catch (error) {
        lastError = error;
        if (!isRetryableControlApiError(error)) throw error;
        if (attempt >= maxAttempts - 1) break;
        await sleep(getControlApiRetryDelayMs(attempt));
      }
    }

    if (depth >= CONTROL_API_MAX_RECURSION_DEPTH) {
      throw lastError instanceof Error
        ? lastError
        : new Error("Control API batch deposit splits history failed");
    }

    const weekSpan = end - start + 1;
    if (weekSpan > CONTROL_API_WEEK_WINDOW_SIZE) {
      if (depth === 0) {
        const status = getErrorStatus(lastError);
        console.warn(
          `[control-api] retry exhausted for deposit splits batch (wallets=${wallets.length}, startWeek=${start}, endWeek=${end}, status=${status ?? "unknown"}); retrying in ${CONTROL_API_WEEK_WINDOW_SIZE}-week windows`
        );
      }
      const windows = chunkWeekRange(start, end, CONTROL_API_WEEK_WINDOW_SIZE);
      const windowResults = await mapWithConcurrency(
        windows,
        CONTROL_API_WEEK_WINDOW_CONCURRENCY,
        async (window) =>
          await fetchBatchWithFallback(
            wallets,
            window.startWeek,
            window.endWeek,
            depth + 1
          )
      );
      const merged = new Map<string, ControlApiDepositSplitHistorySegment[]>();
      for (const m of windowResults) mergeMaps(merged, m);
      return merged;
    }

    if (wallets.length > CONTROL_API_MIN_WALLET_SPLIT_SIZE) {
      if (depth === 0) {
        const status = getErrorStatus(lastError);
        console.warn(
          `[control-api] retry exhausted for deposit splits batch (wallets=${wallets.length}, startWeek=${start}, endWeek=${end}, status=${status ?? "unknown"}); retrying in smaller wallet batches`
        );
      }
      const midpoint = Math.ceil(wallets.length / 2);
      const leftWallets = wallets.slice(0, midpoint);
      const rightWallets = wallets.slice(midpoint);
      if (leftWallets.length === 0 || rightWallets.length === 0) {
        throw lastError instanceof Error
          ? lastError
          : new Error("Control API batch deposit splits history failed");
      }
      const leftMap = await fetchBatchWithFallback(
        leftWallets,
        start,
        end,
        depth + 1
      );
      const rightMap = await fetchBatchWithFallback(
        rightWallets,
        start,
        end,
        depth + 1
      );
      const merged = new Map<string, ControlApiDepositSplitHistorySegment[]>();
      mergeMaps(merged, leftMap);
      mergeMaps(merged, rightMap);
      return merged;
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Control API batch deposit splits history failed");
  };

  const fetched = await fetchBatchWithFallback(
    normalizedWallets,
    startWeek,
    endWeek
  );
  for (const [wallet, rows] of fetched) {
    result.set(wallet, compressSegments(rows));
  }

  return result;
}

export async function fetchFarmRewardsHistoryBatch(params: {
  farmIds: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, ControlApiFarmRewardsHistoryRewardRow[]>> {
  const { startWeek, endWeek } = params;
  const normalizedFarmIds = Array.from(new Set(params.farmIds));
  if (normalizedFarmIds.length === 0)
    return new Map<string, ControlApiFarmRewardsHistoryRewardRow[]>();

  const mergeMaps = (
    target: Map<string, ControlApiFarmRewardsHistoryRewardRow[]>,
    source: Map<string, ControlApiFarmRewardsHistoryRewardRow[]>
  ): void => {
    for (const [farmId, rows] of source) {
      if (!target.has(farmId)) target.set(farmId, []);
      target.get(farmId)!.push(...rows);
    }
  };

  const dedupeRows = (
    rows: ControlApiFarmRewardsHistoryRewardRow[]
  ): ControlApiFarmRewardsHistoryRewardRow[] => {
    const seen = new Set<string>();
    const deduped: ControlApiFarmRewardsHistoryRewardRow[] = [];
    for (const row of rows) {
      const key = [
        row.weekNumber,
        row.paymentCurrency,
        row.protocolDepositRewardsDistributed,
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...row });
    }
    deduped.sort((a, b) => {
      const weekDiff = Number(a.weekNumber) - Number(b.weekNumber);
      if (weekDiff !== 0) return weekDiff;
      return (a.paymentCurrency || "").localeCompare(b.paymentCurrency || "");
    });
    return deduped;
  };

  const buildResultFromWeekCache = (
    farmIds: string[],
    fromWeek: number,
    toWeek: number
  ): Map<string, ControlApiFarmRewardsHistoryRewardRow[]> => {
    const out = new Map<string, ControlApiFarmRewardsHistoryRewardRow[]>();
    const nowMs = Date.now();
    for (const farmId of farmIds) {
      const rows: ControlApiFarmRewardsHistoryRewardRow[] = [];
      let hasMissingWeek = false;
      for (let week = fromWeek; week <= toWeek; week++) {
        const key = makeFarmRewardsWeekCacheKey(farmId, week);
        const cached = cachedFarmRewardsByFarmWeek.get(key);
        if (!cached || nowMs >= cached.expiresAtMs) {
          hasMissingWeek = true;
          break;
        }
        if (cached.rows.length > 0) rows.push(...cloneFarmRewardsRows(cached.rows));
      }
      if (hasMissingWeek) continue;
      if (rows.length > 0) out.set(farmId, dedupeRows(rows));
    }
    return out;
  };

  const fetchBatchOnce = async (
    farmIds: string[],
    start: number,
    end: number
  ): Promise<Map<string, ControlApiFarmRewardsHistoryRewardRow[]>> => {
    const response = await fetch(`${getControlApiUrl()}/farms/rewards-history/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ farmIds, startWeek: start, endWeek: end }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw makeControlApiError(
        `Control API batch farm rewards history failed (${response.status}): ${text}`,
        response.status
      );
    }

    const data =
      (await response.json()) as ControlApiBatchFarmRewardsHistoryResponse;
    const rowsByFarm = data.results || {};
    const batchResult = new Map<string, ControlApiFarmRewardsHistoryRewardRow[]>();
    for (const farmId of farmIds) {
      const row = rowsByFarm[farmId];
      if (!row?.rewards) continue;
      batchResult.set(farmId, row.rewards);
    }
    return batchResult;
  };

  const fetchBatchWithFallback = async (
    farmIds: string[],
    start: number,
    end: number,
    depth = 0
  ): Promise<Map<string, ControlApiFarmRewardsHistoryRewardRow[]>> => {
    const maxAttempts = farmIds.length > 1 ? 3 : 4;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fetchBatchOnce(farmIds, start, end);
      } catch (error) {
        lastError = error;
        if (!isRetryableControlApiError(error)) throw error;
        if (attempt >= maxAttempts - 1) break;
        await sleep(getControlApiRetryDelayMs(attempt));
      }
    }

    if (depth >= CONTROL_API_MAX_RECURSION_DEPTH) {
      throw lastError instanceof Error
        ? lastError
        : new Error("Control API batch farm rewards history failed");
    }

    const weekSpan = end - start + 1;
    if (weekSpan > CONTROL_API_WEEK_WINDOW_SIZE) {
      if (depth === 0) {
        const status = getErrorStatus(lastError);
        console.warn(
          `[control-api] retry exhausted for farm rewards batch (farms=${farmIds.length}, startWeek=${start}, endWeek=${end}, status=${status ?? "unknown"}); retrying in ${CONTROL_API_WEEK_WINDOW_SIZE}-week windows`
        );
      }
      const windows = chunkWeekRange(start, end, CONTROL_API_WEEK_WINDOW_SIZE);
      const windowResults = await mapWithConcurrency(
        windows,
        CONTROL_API_WEEK_WINDOW_CONCURRENCY,
        async (window) =>
          await fetchBatchWithFallback(
            farmIds,
            window.startWeek,
            window.endWeek,
            depth + 1
          )
      );
      const merged = new Map<string, ControlApiFarmRewardsHistoryRewardRow[]>();
      for (const m of windowResults) mergeMaps(merged, m);
      return merged;
    }

    if (farmIds.length > CONTROL_API_MIN_FARM_SPLIT_SIZE) {
      if (depth === 0) {
        const status = getErrorStatus(lastError);
        console.warn(
          `[control-api] retry exhausted for farm rewards batch (farms=${farmIds.length}, startWeek=${start}, endWeek=${end}, status=${status ?? "unknown"}); retrying in smaller farm batches`
        );
      }
      const midpoint = Math.ceil(farmIds.length / 2);
      const leftFarmIds = farmIds.slice(0, midpoint);
      const rightFarmIds = farmIds.slice(midpoint);
      if (leftFarmIds.length === 0 || rightFarmIds.length === 0) {
        throw lastError instanceof Error
          ? lastError
          : new Error("Control API batch farm rewards history failed");
      }
      const leftMap = await fetchBatchWithFallback(
        leftFarmIds,
        start,
        end,
        depth + 1
      );
      const rightMap = await fetchBatchWithFallback(
        rightFarmIds,
        start,
        end,
        depth + 1
      );
      const merged = new Map<string, ControlApiFarmRewardsHistoryRewardRow[]>();
      mergeMaps(merged, leftMap);
      mergeMaps(merged, rightMap);
      return merged;
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Control API batch farm rewards history failed");
  };

  const finalizedWeek = getWeekRange().endWeek;
  const nowMs = Date.now();
  const missingFarmIds = new Set<string>();
  let missingStartWeek = Number.POSITIVE_INFINITY;
  let missingEndWeek = Number.NEGATIVE_INFINITY;

  for (const farmId of normalizedFarmIds) {
    for (let week = startWeek; week <= endWeek; week++) {
      const key = makeFarmRewardsWeekCacheKey(farmId, week);
      const cached = cachedFarmRewardsByFarmWeek.get(key);
      if (cached && nowMs < cached.expiresAtMs) continue;
      missingFarmIds.add(farmId);
      if (week < missingStartWeek) missingStartWeek = week;
      if (week > missingEndWeek) missingEndWeek = week;
    }
  }

  if (missingFarmIds.size > 0) {
    const missingFarmIdsList = Array.from(missingFarmIds);
    const batchKey = makeFarmRewardsBatchCacheKey({
      farmIds: missingFarmIdsList,
      startWeek: missingStartWeek,
      endWeek: missingEndWeek,
    });

    let inFlight = inFlightFarmRewardsBatches.get(batchKey);
    if (!inFlight) {
      inFlight = (async () => {
        const fetched = await fetchBatchWithFallback(
          missingFarmIdsList,
          missingStartWeek,
          missingEndWeek
        );

        const writeNowMs = Date.now();
        for (const farmId of missingFarmIdsList) {
          const rows = fetched.get(farmId) || [];
          const rowsByWeek = new Map<
            number,
            ControlApiFarmRewardsHistoryRewardRow[]
          >();
          for (const row of rows) {
            const week = Number(row.weekNumber);
            if (!Number.isFinite(week)) continue;
            if (week < missingStartWeek || week > missingEndWeek) continue;
            if (!rowsByWeek.has(week)) rowsByWeek.set(week, []);
            rowsByWeek.get(week)!.push({ ...row, weekNumber: week });
          }

          for (let week = missingStartWeek; week <= missingEndWeek; week++) {
            const weekRows = dedupeRows(rowsByWeek.get(week) || []);
            const ttlMs =
              week <= finalizedWeek
                ? CONTROL_API_FARM_REWARDS_TTL_FINALIZED_MS
                : CONTROL_API_FARM_REWARDS_TTL_CURRENT_MS;
            cachedFarmRewardsByFarmWeek.set(
              makeFarmRewardsWeekCacheKey(farmId, week),
              {
                rows: weekRows,
                expiresAtMs: writeNowMs + ttlMs,
              }
            );
          }
        }

        return fetched;
      })();
      inFlightFarmRewardsBatches.set(batchKey, inFlight);
    }

    try {
      await inFlight;
    } finally {
      if (inFlightFarmRewardsBatches.get(batchKey) === inFlight) {
        inFlightFarmRewardsBatches.delete(batchKey);
      }
    }
  }

  return buildResultFromWeekCache(normalizedFarmIds, startWeek, endWeek);
}

export async function fetchWalletRewardsHistoryMany(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
  batchSize?: number;
  concurrentBatches?: number;
}): Promise<Map<string, ControlApiFarmReward[]>> {
  const {
    wallets,
    startWeek,
    endWeek,
    batchSize = 500,
    concurrentBatches = 5,
  } = params;

  const result = new Map<string, ControlApiFarmReward[]>();
  if (wallets.length === 0) return result;

  const normalizedWallets = Array.from(
    new Set(wallets.map((w) => w.toLowerCase()))
  );

  for (
    let i = 0;
    i < normalizedWallets.length;
    i += batchSize * concurrentBatches
  ) {
    const batchPromises: Array<Promise<Map<string, ControlApiFarmReward[]>>> =
      [];

    for (
      let j = 0;
      j < concurrentBatches && i + j * batchSize < normalizedWallets.length;
      j++
    ) {
      const batch = normalizedWallets.slice(
        i + j * batchSize,
        i + (j + 1) * batchSize
      );

      batchPromises.push(
        fetchWalletRewardsHistoryBatch({ wallets: batch, startWeek, endWeek })
          .then((m) => m)
          .catch((error) => {
            console.error(
              `[control-api] batch wallet rewards failed (wallets=${batch.length}, startWeek=${startWeek}, endWeek=${endWeek})`,
              error
            );
            return new Map<string, ControlApiFarmReward[]>();
          })
      );
    }

    const batchResults = await Promise.all(batchPromises);
    for (const batchMap of batchResults) {
      for (const [wallet, rewards] of batchMap) {
        result.set(wallet, rewards);
      }
    }
  }

  return result;
}

const cachedRegionRewardsByEpoch = new Map<
  number,
  { data: RegionRewardsResponse; expiresAtMs: number }
>();
const inFlightRegionRewardsByEpoch = new Map<
  number,
  Promise<RegionRewardsResponse>
>();
const cachedWalletStakeByEpoch = new Map<
  string,
  {
    data: Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>;
    expiresAtMs: number;
  }
>();
const inFlightWalletStakeByEpoch = new Map<
  string,
  Promise<Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>>
>();
let controlRegionRewardsTableAvailable: boolean | null = null;
let controlWalletStakeTableAvailable: boolean | null = null;

async function readRegionRewardsFromDb(
  epoch: number
): Promise<RegionRewardsResponse | null> {
  if (controlRegionRewardsTableAvailable === false) return null;

  try {
    const rows = await db
      .select({
        regionId: controlRegionRewardsWeek.regionId,
        glwRewardRaw: controlRegionRewardsWeek.glwRewardRaw,
        gctlStakedRaw: controlRegionRewardsWeek.gctlStakedRaw,
        rewardShareRaw: controlRegionRewardsWeek.rewardShareRaw,
      })
      .from(controlRegionRewardsWeek)
      .where(eq(controlRegionRewardsWeek.weekNumber, epoch));

    if (rows.length === 0) return null;
    controlRegionRewardsTableAvailable = true;

    const regionRewards: RegionRewardsResponse["regionRewards"] = [];
    let totalGctlStaked = 0n;
    let totalGlwRewards = 0n;

    for (const row of rows) {
      const glwReward = safeBigInt(row.glwRewardRaw);
      const gctlStaked = safeBigInt(row.gctlStakedRaw);
      const rewardShare = String(row.rewardShareRaw ?? "0");

      if (row.regionId > 0) {
        regionRewards.push({
          regionId: row.regionId,
          gctlStaked: gctlStaked.toString(),
          glwReward: glwReward.toString(),
          rewardShare,
        });
      }

      if (glwReward > 0n) totalGlwRewards += glwReward;
      if (gctlStaked > 0n) totalGctlStaked += gctlStaked;
    }

    return {
      totalGctlStaked: totalGctlStaked.toString(),
      totalGlwRewards: totalGlwRewards.toString(),
      regionRewards,
    };
  } catch (error) {
    if (isUndefinedTableError(error)) {
      controlRegionRewardsTableAvailable = false;
      return null;
    }
    throw error;
  }
}

async function upsertRegionRewardsToDb(
  epoch: number,
  data: RegionRewardsResponse
): Promise<void> {
  if (controlRegionRewardsTableAvailable === false) return;
  const currentEpoch = getCurrentEpoch(Math.floor(Date.now() / 1000));
  // Only persist finalized epochs; live week remains API-first to avoid churn.
  if (epoch >= currentEpoch) return;

  const fetchedAt = new Date();
  const rowsRaw =
    (data.regionRewards || []).length > 0
      ? (data.regionRewards || []).map((row) => ({
          weekNumber: epoch,
          regionId: Number(row.regionId),
          glwRewardRaw: String(row.glwReward || "0"),
          gctlStakedRaw: String(row.gctlStaked || "0"),
          rewardShareRaw: String(row.rewardShare || "0"),
          fetchedAt,
        }))
      : [
          {
            weekNumber: epoch,
            regionId: 0,
            glwRewardRaw: "0",
            gctlStakedRaw: "0",
            rewardShareRaw: "0",
            fetchedAt,
          },
        ];
  const rowsByRegion = new Map<
    number,
    (typeof controlRegionRewardsWeek.$inferInsert)
  >();
  for (const row of rowsRaw) {
    rowsByRegion.set(row.regionId, row);
  }
  const rows = Array.from(rowsByRegion.values());

  try {
    const existing = await db
      .select({ regionId: controlRegionRewardsWeek.regionId })
      .from(controlRegionRewardsWeek)
      .where(eq(controlRegionRewardsWeek.weekNumber, epoch));
    if (existing.length > 0) {
      controlRegionRewardsTableAvailable = true;
      return;
    }

    await db
      .insert(controlRegionRewardsWeek)
      .values(rows)
      .onConflictDoNothing({
        target: [
          controlRegionRewardsWeek.weekNumber,
          controlRegionRewardsWeek.regionId,
        ],
      });
    controlRegionRewardsTableAvailable = true;
  } catch (error) {
    if (isUndefinedTableError(error)) {
      controlRegionRewardsTableAvailable = false;
      return;
    }
    console.warn(
      `[control-api] failed to persist region rewards to DB (epoch=${epoch})`,
      error
    );
  }
}

async function readWalletStakeRangeFromDb(params: {
  walletAddress: string;
  startWeek: number;
  endWeek: number;
}): Promise<Map<number, Array<{ regionId: number; totalStakedWei: bigint }>> | null> {
  if (controlWalletStakeTableAvailable === false) return null;

  const wallet = params.walletAddress.toLowerCase();

  try {
    const rows = await db
      .select({
        weekNumber: controlWalletStakeByEpoch.weekNumber,
        regionId: controlWalletStakeByEpoch.regionId,
        totalStakedRaw: controlWalletStakeByEpoch.totalStakedRaw,
      })
      .from(controlWalletStakeByEpoch)
      .where(
        and(
          eq(controlWalletStakeByEpoch.wallet, wallet),
          gte(controlWalletStakeByEpoch.weekNumber, params.startWeek),
          lte(controlWalletStakeByEpoch.weekNumber, params.endWeek)
        )
      );
    if (rows.length === 0) return null;
    controlWalletStakeTableAvailable = true;

    const coveredWeeks = new Set<number>(rows.map((r) => r.weekNumber));
    for (let week = params.startWeek; week <= params.endWeek; week++) {
      if (!coveredWeeks.has(week)) return null;
    }

    const out = new Map<
      number,
      Array<{ regionId: number; totalStakedWei: bigint }>
    >();
    for (let week = params.startWeek; week <= params.endWeek; week++) {
      out.set(week, []);
    }

    for (const row of rows) {
      if (row.regionId <= 0) continue;
      out.get(row.weekNumber)!.push({
        regionId: row.regionId,
        totalStakedWei: safeBigInt(row.totalStakedRaw),
      });
    }

    return out;
  } catch (error) {
    if (isUndefinedTableError(error)) {
      controlWalletStakeTableAvailable = false;
      return null;
    }
    throw error;
  }
}

async function upsertWalletStakeRangeToDb(params: {
  walletAddress: string;
  startWeek: number;
  endWeek: number;
  rowsByWeek: Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>;
}): Promise<void> {
  if (controlWalletStakeTableAvailable === false) return;

  const wallet = params.walletAddress.toLowerCase();
  const currentEpoch = getCurrentEpoch(Math.floor(Date.now() / 1000));
  const writeEndWeek = Math.min(params.endWeek, currentEpoch - 1);
  if (writeEndWeek < params.startWeek) return;
  const fetchedAt = new Date();
  let existingWeekRows: Array<{ weekNumber: number }> = [];
  try {
    existingWeekRows = await db
      .select({ weekNumber: controlWalletStakeByEpoch.weekNumber })
      .from(controlWalletStakeByEpoch)
      .where(
        and(
          eq(controlWalletStakeByEpoch.wallet, wallet),
          gte(controlWalletStakeByEpoch.weekNumber, params.startWeek),
          lte(controlWalletStakeByEpoch.weekNumber, writeEndWeek)
        )
      );
  } catch (error) {
    if (isUndefinedTableError(error)) {
      controlWalletStakeTableAvailable = false;
      return;
    }
    throw error;
  }
  const existingWeeks = new Set(existingWeekRows.map((row) => row.weekNumber));

  const rows: Array<
    typeof controlWalletStakeByEpoch.$inferInsert
  > = [];

  for (let week = params.startWeek; week <= writeEndWeek; week++) {
    if (existingWeeks.has(week)) continue;
    const weekRows = params.rowsByWeek.get(week) || [];
    if (weekRows.length === 0) {
      rows.push({
        weekNumber: week,
        wallet,
        regionId: 0,
        totalStakedRaw: "0",
        pendingUnstakeRaw: "0",
        pendingRestakeOutRaw: "0",
        pendingRestakeInRaw: "0",
        fetchedAt,
      });
      continue;
    }

    const dedupedByRegion = new Map<number, bigint>();
    for (const row of weekRows) {
      dedupedByRegion.set(row.regionId, row.totalStakedWei);
    }
    for (const [regionId, totalStakedWei] of dedupedByRegion) {
      rows.push({
        weekNumber: week,
        wallet,
        regionId,
        totalStakedRaw: totalStakedWei.toString(),
        pendingUnstakeRaw: "0",
        pendingRestakeOutRaw: "0",
        pendingRestakeInRaw: "0",
        fetchedAt,
      });
    }
  }

  if (rows.length === 0) return;

  try {
    await db
      .insert(controlWalletStakeByEpoch)
      .values(rows)
      .onConflictDoNothing({
        target: [
          controlWalletStakeByEpoch.weekNumber,
          controlWalletStakeByEpoch.wallet,
          controlWalletStakeByEpoch.regionId,
        ],
      });
    controlWalletStakeTableAvailable = true;
  } catch (error) {
    if (isUndefinedTableError(error)) {
      controlWalletStakeTableAvailable = false;
      return;
    }
    console.warn(
      `[control-api] failed to persist wallet stake range to DB (wallet=${wallet}, startWeek=${params.startWeek}, endWeek=${params.endWeek})`,
      error
    );
  }
}

export async function getRegionRewardsAtEpoch(params: {
  epoch: number;
  ttlMs?: number;
}): Promise<RegionRewardsResponse> {
  const { epoch } = params;
  const currentEpoch = getCurrentEpoch(Math.floor(Date.now() / 1000));
  const isFinalizedEpoch = epoch < currentEpoch;
  const now = Date.now();
  const cached = cachedRegionRewardsByEpoch.get(epoch);
  if (cached && now < cached.expiresAtMs) return cached.data;

  const inFlight = inFlightRegionRewardsByEpoch.get(epoch);
  if (inFlight) return inFlight;

  if (isFinalizedEpoch) {
    try {
      const dbData = await readRegionRewardsFromDb(epoch);
      if (dbData) {
        const nowMs = Date.now();
        const ttlMs =
          params.ttlMs ??
          (epoch < getCurrentEpoch(Math.floor(nowMs / 1000))
            ? CONTROL_API_EPOCH_REWARDS_TTL_FINALIZED_MS
            : CONTROL_API_EPOCH_REWARDS_TTL_CURRENT_MS);
        cachedRegionRewardsByEpoch.set(epoch, {
          data: dbData,
          expiresAtMs: nowMs + ttlMs,
        });
        return dbData;
      }
    } catch (error) {
      console.warn(
        `[control-api] DB read failed for region rewards (epoch=${epoch}); falling back to Control API`,
        error
      );
    }
  }

  const requestedTtlMs = params.ttlMs;
  const request = (async () => {
    let lastError: unknown = null;
    for (
      let attempt = 0;
      attempt < CONTROL_API_SINGLE_ENDPOINT_MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        const response = await fetch(
          `${getControlApiUrl()}/regions/rewards/glw/regions?epoch=${epoch}`
        );
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw makeControlApiError(
            `Control API region rewards (epoch=${epoch}) failed (${response.status}): ${text}`,
            response.status
          );
        }
        const data = (await response.json()) as RegionRewardsResponse;
        const nowMs = Date.now();
        const ttlMs =
          requestedTtlMs ??
          (epoch < getCurrentEpoch(Math.floor(nowMs / 1000))
            ? CONTROL_API_EPOCH_REWARDS_TTL_FINALIZED_MS
            : CONTROL_API_EPOCH_REWARDS_TTL_CURRENT_MS);
        cachedRegionRewardsByEpoch.set(epoch, {
          data,
          expiresAtMs: nowMs + ttlMs,
        });
        await upsertRegionRewardsToDb(epoch, data);
        return data;
      } catch (error) {
        lastError = error;
        if (!isRetryableControlApiError(error)) break;
        if (attempt >= CONTROL_API_SINGLE_ENDPOINT_MAX_ATTEMPTS - 1) break;
        await sleep(getControlApiRetryDelayMs(attempt));
      }
    }

    const stale = cachedRegionRewardsByEpoch.get(epoch);
    if (stale) {
      const status = getErrorStatus(lastError);
      console.warn(
        `[control-api] region rewards fetch failed (epoch=${epoch}, status=${status ?? "unknown"}); using stale cached value`
      );
      return stale.data;
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Control API region rewards (epoch=${epoch}) failed`);
  })();

  inFlightRegionRewardsByEpoch.set(epoch, request);
  try {
    return await request;
  } finally {
    inFlightRegionRewardsByEpoch.delete(epoch);
  }
}

function makeWalletStakeCacheKey(params: {
  walletAddress: string;
  startWeek: number;
  endWeek: number;
}): string {
  return `${params.walletAddress.toLowerCase()}|${params.startWeek}|${
    params.endWeek
  }`;
}

async function fetchWalletStakeByEpochOnce(params: {
  walletAddress: string;
  startWeek: number;
  endWeek: number;
}): Promise<Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>> {
  const wallet = params.walletAddress.toLowerCase();
  const response = await fetch(
    `${getControlApiUrl()}/wallets/address/${wallet}/stake-by-epoch?startEpoch=${
      params.startWeek
    }&endEpoch=${params.endWeek}`
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw makeControlApiError(
      `Control API wallet stake-by-epoch failed (${response.status}): ${text}`,
      response.status
    );
  }
  const data = (await response.json()) as WalletStakeByEpochResponse;
  const map = new Map<
    number,
    Array<{ regionId: number; totalStakedWei: bigint }>
  >();
  for (const row of data.results || []) {
    const regions = (row.regions || []).map((r) => ({
      regionId: r.regionId,
      totalStakedWei: BigInt(r.totalStaked || "0"),
    }));
    map.set(row.epoch, regions);
  }
  return map;
}

function mergeWalletStakeEpochMaps(
  target: Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>,
  source: Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>
): void {
  for (const [epoch, rows] of source) {
    target.set(epoch, rows);
  }
}

async function fetchWalletStakeByEpochWithFallback(
  params: {
    walletAddress: string;
    startWeek: number;
    endWeek: number;
  },
  depth = 0
): Promise<Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>> {
  let lastError: unknown = null;

  for (
    let attempt = 0;
    attempt < CONTROL_API_SINGLE_ENDPOINT_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      return await fetchWalletStakeByEpochOnce(params);
    } catch (error) {
      lastError = error;
      if (!isRetryableControlApiError(error)) throw error;
      if (attempt >= CONTROL_API_SINGLE_ENDPOINT_MAX_ATTEMPTS - 1) break;
      await sleep(getControlApiRetryDelayMs(attempt));
    }
  }

  if (depth >= CONTROL_API_MAX_RECURSION_DEPTH) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Control API wallet stake-by-epoch failed");
  }

  const weekSpan = params.endWeek - params.startWeek + 1;
  if (weekSpan > CONTROL_API_WEEK_WINDOW_SIZE) {
    if (depth === 0) {
      const status = getErrorStatus(lastError);
      console.warn(
        `[control-api] retry exhausted for wallet stake-by-epoch (wallet=${params.walletAddress.toLowerCase()}, startWeek=${params.startWeek}, endWeek=${params.endWeek}, status=${status ?? "unknown"}); retrying in ${CONTROL_API_WEEK_WINDOW_SIZE}-week windows`
      );
    }
    const windows = chunkWeekRange(
      params.startWeek,
      params.endWeek,
      CONTROL_API_WEEK_WINDOW_SIZE
    );
    const windowResults = await mapWithConcurrency(
      windows,
      CONTROL_API_WEEK_WINDOW_CONCURRENCY,
      async (window) =>
        await fetchWalletStakeByEpochWithFallback(
          {
            walletAddress: params.walletAddress,
            startWeek: window.startWeek,
            endWeek: window.endWeek,
          },
          depth + 1
        )
    );
    const merged = new Map<
      number,
      Array<{ regionId: number; totalStakedWei: bigint }>
    >();
    for (const windowMap of windowResults) {
      mergeWalletStakeEpochMaps(merged, windowMap);
    }
    return merged;
  }

  if (weekSpan > 1) {
    if (depth === 0) {
      const status = getErrorStatus(lastError);
      console.warn(
        `[control-api] retry exhausted for wallet stake-by-epoch (wallet=${params.walletAddress.toLowerCase()}, startWeek=${params.startWeek}, endWeek=${params.endWeek}, status=${status ?? "unknown"}); retrying in smaller week ranges`
      );
    }
    const midpoint = params.startWeek + Math.floor(weekSpan / 2);
    const left = await fetchWalletStakeByEpochWithFallback(
      {
        walletAddress: params.walletAddress,
        startWeek: params.startWeek,
        endWeek: midpoint - 1,
      },
      depth + 1
    );
    const right = await fetchWalletStakeByEpochWithFallback(
      {
        walletAddress: params.walletAddress,
        startWeek: midpoint,
        endWeek: params.endWeek,
      },
      depth + 1
    );
    const merged = new Map<
      number,
      Array<{ regionId: number; totalStakedWei: bigint }>
    >();
    mergeWalletStakeEpochMaps(merged, left);
    mergeWalletStakeEpochMaps(merged, right);
    return merged;
  }

  const stale = cachedWalletStakeByEpoch.get(makeWalletStakeCacheKey(params));
  if (stale) {
    const status = getErrorStatus(lastError);
    console.warn(
      `[control-api] wallet stake-by-epoch failed (wallet=${params.walletAddress.toLowerCase()}, startWeek=${params.startWeek}, endWeek=${params.endWeek}, status=${status ?? "unknown"}); using stale cached value`
    );
    return stale.data;
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Control API wallet stake-by-epoch failed");
}

async function getWalletStakeByEpoch(params: {
  walletAddress: string;
  startWeek: number;
  endWeek: number;
}): Promise<Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>> {
  const currentEpoch = getCurrentEpoch(Math.floor(Date.now() / 1000));
  const isFinalizedRange = params.endWeek < currentEpoch;
  const cacheKey = makeWalletStakeCacheKey(params);
  const now = Date.now();
  const cached = cachedWalletStakeByEpoch.get(cacheKey);
  if (cached && now < cached.expiresAtMs) return cached.data;

  const inFlight = inFlightWalletStakeByEpoch.get(cacheKey);
  if (inFlight) return inFlight;

  if (isFinalizedRange) {
    try {
      const dbData = await readWalletStakeRangeFromDb(params);
      if (dbData) {
        const nowMs = Date.now();
        const ttlMs =
          params.endWeek < getCurrentEpoch(Math.floor(nowMs / 1000))
            ? CONTROL_API_WALLET_STAKE_TTL_FINALIZED_MS
            : CONTROL_API_WALLET_STAKE_TTL_CURRENT_MS;
        cachedWalletStakeByEpoch.set(cacheKey, {
          data: dbData,
          expiresAtMs: nowMs + ttlMs,
        });
        return dbData;
      }
    } catch (error) {
      console.warn(
        `[control-api] DB read failed for wallet stake-by-epoch (wallet=${params.walletAddress.toLowerCase()}, startWeek=${params.startWeek}, endWeek=${params.endWeek}); falling back to Control API`,
        error
      );
    }
  }

  const request = (async () => {
    const data = await fetchWalletStakeByEpochWithFallback(params);
    await upsertWalletStakeRangeToDb({
      walletAddress: params.walletAddress,
      startWeek: params.startWeek,
      endWeek: params.endWeek,
      rowsByWeek: data,
    });
    const nowMs = Date.now();
    const ttlMs =
      params.endWeek < getCurrentEpoch(Math.floor(nowMs / 1000))
        ? CONTROL_API_WALLET_STAKE_TTL_FINALIZED_MS
        : CONTROL_API_WALLET_STAKE_TTL_CURRENT_MS;
    cachedWalletStakeByEpoch.set(cacheKey, {
      data,
      expiresAtMs: nowMs + ttlMs,
    });
    return data;
  })();

  inFlightWalletStakeByEpoch.set(cacheKey, request);
  try {
    return await request;
  } finally {
    inFlightWalletStakeByEpoch.delete(cacheKey);
  }
}

export async function fetchWalletStakeByEpochRange(params: {
  walletAddress: string;
  startWeek: number;
  endWeek: number;
}): Promise<Map<number, Array<{ regionId: number; totalStakedWei: bigint }>>> {
  return await getWalletStakeByEpoch(params);
}

export async function getUnclaimedGlwRewardsWei(
  walletAddress: string,
  opts: { mode?: "lite" | "accurate"; startWeek: number; endWeek: number }
): Promise<UnclaimedGlwRewardsResult> {
  const wallet = walletAddress.toLowerCase();
  const mode = opts?.mode ?? "lite";
  const startWeek = opts.startWeek;
  const endWeek = opts.endWeek;

  // 1) Total earned GLW rewards from Control API weekly rewards table (GLW currency only)
  const weeklyResp = await fetch(
    `${getControlApiUrl()}/wallets/address/${wallet}/weekly-rewards?paymentCurrency=GLW&limit=520`
  );
  if (!weeklyResp.ok) {
    const text = await weeklyResp.text().catch(() => "");
    throw new Error(
      `Control API weekly rewards failed (${weeklyResp.status}): ${text}`
    );
  }

  const weeklyData: any = await weeklyResp.json();
  const rewards: any[] = weeklyData?.rewards || [];

  // 2) Claimed GLW from claims API (on-chain claim transfers)
  const claimsResp = await fetch(
    `${getPonderListenerBaseUrl()}/rewards/claims/${wallet}?limit=5000`
  );

  if (claimsResp.status === 503) {
    const text = await claimsResp.text().catch(() => "");
    throw new Error(`Claims API is still indexing: ${text}`);
  }

  if (!claimsResp.ok) {
    const text = await claimsResp.text().catch(() => "");
    throw new Error(`Claims API fetch failed (${claimsResp.status}): ${text}`);
  }

  const claimsData: any = await claimsResp.json();
  const indexingComplete = claimsData?.indexingComplete === true;
  if (!indexingComplete) {
    throw new Error("Claims API is still indexing");
  }

  const claims: any[] = claimsData?.claims || [];

  const glwToken = MAINNET_GLOW_TOKEN;

  // Interpretation that matches the wallet UI + onchain truth:
  // - Only count weeks that are finalized/claimable (lag windows)
  // - Attribute claims to the *reward week* (not the claim timestamp)
  //
  // RewardsKernel: claim row includes `nonce` -> deterministic week mapping.
  // MinerPool: claim rows are indexed from GLW Transfer logs; they don't include the week.
  // We infer the week by matching claim amount to the Control API per-week `glowInflationTotal`
  // (allowing a tiny wei epsilon to tolerate downstream rounding).

  const maxWeek = rewards.reduce((max, r) => {
    const w = Number(r?.weekNumber ?? -1);
    return Number.isFinite(w) && w > max ? w : max;
  }, -1);

  // Finality windows consistent with the wallet claims UI:
  // - GLW inflation considered claimable after 3 weeks
  // - Protocol deposit payouts considered claimable after 4 weeks
  const nowSec = Math.floor(Date.now() / 1000);
  const currentEpoch = getCurrentEpoch(nowSec);
  const claimableThresholdWeek = Math.min(currentEpoch - 3, currentEpoch - 4);
  const claimableEndWeek = Math.min(endWeek, maxWeek, claimableThresholdWeek);
  if (claimableEndWeek < startWeek) {
    return { amountWei: BigInt(0), dataSource: "claims-api+control-api" };
  }

  // Build week -> {inflation,pd} from Control API
  const byWeek = new Map<number, { inflationWei: bigint; pdWei: bigint }>();
  for (const r of rewards) {
    const weekNumber = Number(r?.weekNumber ?? -1);
    if (!Number.isFinite(weekNumber) || weekNumber < 0) continue;
    byWeek.set(weekNumber, {
      inflationWei: safeBigInt(r?.glowInflationTotal),
      pdWei: safeBigInt(r?.protocolDepositRewardsReceived),
    });
  }

  // Claimed weeks (PD) from RewardsKernel nonce -> week
  const claimedPdWeeks = new Set<number>();
  for (const c of claims) {
    const token = String(c?.token || "").toLowerCase();
    if (token !== glwToken) continue;
    const source = String(c?.source || "");
    if (source !== "rewardsKernel") continue;
    const week = getV2WeekFromNonce(c?.nonce);
    if (week != null) claimedPdWeeks.add(week);
  }

  // Claimed weeks (inflation) from MinerPool transfer amounts -> closest week inflation
  // We accept matches within this epsilon (observed diffs are a few million wei).
  const AMOUNT_MATCH_EPSILON_WEI = BigInt(10_000_000);
  const claimedInflationWeeks = new Set<number>();

  function inferWeekFromInflationAmount(amountWei: bigint): number | null {
    let bestWeek: number | null = null;
    let bestDiff: bigint | null = null;
    let secondBestDiff: bigint | null = null;

    for (const [week, v] of byWeek) {
      const diff =
        amountWei >= v.inflationWei
          ? amountWei - v.inflationWei
          : v.inflationWei - amountWei;
      if (bestDiff == null || diff < bestDiff) {
        secondBestDiff = bestDiff;
        bestDiff = diff;
        bestWeek = week;
        continue;
      }
      if (secondBestDiff == null || diff < secondBestDiff)
        secondBestDiff = diff;
    }

    if (bestWeek == null || bestDiff == null) return null;
    if (bestDiff > AMOUNT_MATCH_EPSILON_WEI) return null;
    // If another week is also within epsilon, we can't safely disambiguate.
    if (secondBestDiff != null && secondBestDiff <= AMOUNT_MATCH_EPSILON_WEI)
      return null;
    return bestWeek;
  }

  if (mode === "accurate") {
    for (const c of claims) {
      const token = String(c?.token || "").toLowerCase();
      if (token !== glwToken) continue;
      const source = String(c?.source || "");
      if (source !== "minerPool") continue;
      const week = inferWeekFromInflationAmount(safeBigInt(c?.amount));
      if (week != null) claimedInflationWeeks.add(week);
    }
  }

  let unclaimedWei = BigInt(0);

  for (let w = startWeek; w <= claimableEndWeek; w++) {
    const v = byWeek.get(w);
    if (!v) continue;

    if (v.inflationWei > BigInt(0)) {
      // In lite mode we don't try to infer MinerPool claim weeks (keeps leaderboard cheap).
      const isClaimed =
        mode === "accurate" ? claimedInflationWeeks.has(w) : false;
      if (!isClaimed) unclaimedWei += v.inflationWei;
    }

    if (v.pdWei > BigInt(0)) {
      const isClaimed = claimedPdWeeks.has(w);
      if (!isClaimed) unclaimedWei += v.pdWei;
    }
  }

  return {
    amountWei: unclaimedWei > BigInt(0) ? unclaimedWei : BigInt(0),
    dataSource: "claims-api+control-api",
  };
}

export async function fetchClaimsBatch(params: {
  wallets: string[];
  batchSize?: number;
  concurrentBatches?: number;
}): Promise<Map<string, any[]>> {
  const { wallets, batchSize = 500, concurrentBatches = 3 } = params;
  const result = new Map<string, any[]>();
  if (wallets.length === 0) return result;

  const normalizedWallets = Array.from(
    new Set(wallets.map((w) => w.toLowerCase()))
  );

  const baseUrl = getPonderListenerBaseUrl();

  async function fetchOneBatch(batch: string[]): Promise<void> {
    const response = await fetch(`${baseUrl}/rewards/claims/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets: batch }),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(
        `Claims API batch failed (${response.status}): ${text || "<empty>"}`
      );
    }
    const json = JSON.parse(text);
    if (json?.indexingComplete === false)
      throw new Error(json?.error || "Claims API is still indexing");

    const results = (json?.results || {}) as Record<string, any[]>;
    for (const [wallet, claims] of Object.entries(results)) {
      result.set(wallet.toLowerCase(), claims);
    }
  }

  for (
    let i = 0;
    i < normalizedWallets.length;
    i += batchSize * concurrentBatches
  ) {
    const batchPromises: Array<Promise<void>> = [];
    for (
      let j = 0;
      j < concurrentBatches && i + j * batchSize < normalizedWallets.length;
      j++
    ) {
      const batch = normalizedWallets.slice(
        i + j * batchSize,
        i + (j + 1) * batchSize
      );
      batchPromises.push(
        fetchOneBatch(batch).catch((error) => {
          console.error(
            `[claims-api] batch claims failed (wallets=${batch.length})`,
            error
          );
        })
      );
    }
    await Promise.all(batchPromises);
  }

  return result;
}

export async function fetchClaimedPdWeeksBatch(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
  batchSize?: number;
  concurrentBatches?: number;
}): Promise<Map<string, Map<number, number>>> {
  const {
    wallets,
    startWeek,
    endWeek,
    batchSize = 200,
    concurrentBatches = 4,
  } = params;

  const result = new Map<string, Map<number, number>>();
  const normalizedWallets = Array.from(
    new Set(wallets.map((w) => w.toLowerCase()))
  );
  for (const w of normalizedWallets) result.set(w, new Map());
  if (normalizedWallets.length === 0) return result;

  const baseUrl = getPonderListenerBaseUrl();
  const GENESIS_TIMESTAMP = 1700352000;
  const WEEK_97_START_TIMESTAMP = GENESIS_TIMESTAMP + 97 * 604800;

  async function fetchBatch(batch: string[]): Promise<void> {
    const response = await fetch(`${baseUrl}/rewards/claimed-pd-weeks/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets: batch, startWeek, endWeek }),
    });
    const text = await response.text().catch(() => "");

    if (response.status === 503)
      throw new Error(`Claims API is still indexing: ${text}`);
    if (!response.ok)
      throw new Error(
        `Claims API batch PD weeks failed (${response.status}): ${
          text || "<empty>"
        }`
      );

    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `Claims API batch PD weeks returned invalid JSON: ${text}`
      );
    }
    if (json?.indexingComplete === false)
      throw new Error(json?.error || "Claims API is still indexing");

    const results = (json?.results || {}) as Record<
      string,
      Record<string, number>
    >;
    for (const wallet of Object.keys(results)) {
      const weeksMap = results[wallet];
      if (!weeksMap || typeof weeksMap !== "object") continue;
      const key = wallet.toLowerCase();
      if (!result.has(key)) result.set(key, new Map());
      const map = result.get(key)!;
      for (const [weekStr, timestamp] of Object.entries(weeksMap)) {
        const weekNumber = Number(weekStr);
        if (!Number.isFinite(weekNumber)) continue;
        const ts = Number(timestamp);
        // Filter out claims that happened before Week 97 started (v1 system)
        if (ts < WEEK_97_START_TIMESTAMP) continue;
        if (weekNumber < 97) continue;
        map.set(Math.trunc(weekNumber), ts);
      }
    }
  }

  for (
    let i = 0;
    i < normalizedWallets.length;
    i += batchSize * concurrentBatches
  ) {
    const batchPromises: Array<Promise<void>> = [];
    for (
      let j = 0;
      j < concurrentBatches && i + j * batchSize < normalizedWallets.length;
      j++
    ) {
      const batch = normalizedWallets.slice(
        i + j * batchSize,
        i + (j + 1) * batchSize
      );
      batchPromises.push(
        fetchBatch(batch).catch((error) => {
          console.error(
            `[claims-api] batch claimed PD weeks failed (wallets=${batch.length}, startWeek=${startWeek}, endWeek=${endWeek})`,
            error
          );
        })
      );
    }
    await Promise.all(batchPromises);
  }

  return result;
}

export async function getGctlSteeringByWeekWei(params: {
  walletAddress: string;
  startWeek: number;
  endWeek: number;
  regionRewardsByEpoch?: Map<number, RegionRewardsResponse>;
}): Promise<SteeringByWeekResult> {
  const { walletAddress, startWeek, endWeek, regionRewardsByEpoch } = params;

  const byWeek = new Map<number, bigint>();
  const byWeekAndRegion = new Map<number, Map<number, bigint>>();

  try {
    const weeks = Array.from({ length: endWeek - startWeek + 1 }, (_, i) => startWeek + i);
    const missingRewardWeeks = weeks.filter(
      (w) => !(regionRewardsByEpoch?.has(w) ?? false)
    );

    const [walletStakeByEpoch, ...fetchedRegionRewards] = await Promise.all([
      getWalletStakeByEpoch({ walletAddress, startWeek, endWeek }),
      ...missingRewardWeeks.map((w) => getRegionRewardsAtEpoch({ epoch: w })),
    ]);

    const regionRewardsByWeek = new Map<number, RegionRewardsResponse>();
    if (regionRewardsByEpoch) {
      for (const [week, row] of regionRewardsByEpoch) {
        if (week < startWeek || week > endWeek) continue;
        regionRewardsByWeek.set(week, row);
      }
    }
    missingRewardWeeks.forEach((w, i) =>
      regionRewardsByWeek.set(w, fetchedRegionRewards[i]!)
    );

    for (let w = startWeek; w <= endWeek; w++) {
      const regionRewards = regionRewardsByWeek.get(w);
      if (!regionRewards) continue;
      const regionRewardById = new Map<
        number,
        { gctlStaked: bigint; glwRewardWei: bigint }
      >();
      for (const r of regionRewards.regionRewards || []) {
        regionRewardById.set(r.regionId, {
          gctlStaked: BigInt(r.gctlStaked || "0"),
          glwRewardWei: BigInt(r.glwReward || "0"),
        });
      }

      const walletRegions = walletStakeByEpoch.get(w) || [];
      let steeredGlwWei = BigInt(0);
      const regionSteering = new Map<number, bigint>();

      for (const r of walletRegions) {
        const walletStakeWei = r.totalStakedWei;
        const region = regionRewardById.get(r.regionId);
        if (!region) continue;
        if (walletStakeWei <= BigInt(0) || region.gctlStaked <= BigInt(0))
          continue;

        const regionSteered =
          (region.glwRewardWei * walletStakeWei) / region.gctlStaked;
        steeredGlwWei += regionSteered;
        regionSteering.set(r.regionId, regionSteered);
      }

      byWeek.set(w, steeredGlwWei);
      byWeekAndRegion.set(w, regionSteering);
    }

    return { byWeek, byWeekAndRegion, dataSource: "control-api" };
  } catch (error) {
    const snapshot = await getSteeringSnapshot(walletAddress);
    for (let w = startWeek; w <= endWeek; w++) {
      byWeek.set(w, snapshot.steeredGlwWeiPerWeek);
      if (snapshot.byRegion) {
        if (!byWeekAndRegion.has(w)) byWeekAndRegion.set(w, new Map());
        const weekMap = byWeekAndRegion.get(w)!;
        for (const [rid, val] of snapshot.byRegion) weekMap.set(rid, val);
      }
    }
    return {
      byWeek,
      byWeekAndRegion: snapshot.byRegion ? byWeekAndRegion : undefined,
      dataSource: "control-api",
      isFallback: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getSteeringSnapshot(
  walletAddress: string,
  epoch?: number
): Promise<SteeringSnapshot> {
  const wallet = walletAddress.toLowerCase();

  let walletRegions: Array<{ regionId: number; totalStaked: string }> = [];

  if (epoch != null) {
    // Use epoch-based stake snapshot from getWalletStakeByEpoch
    const stakeByEpoch = await getWalletStakeByEpoch({
      walletAddress: wallet,
      startWeek: epoch,
      endWeek: epoch,
    });
    const epochStakes = stakeByEpoch.get(epoch) || [];
    walletRegions = epochStakes.map((r) => ({
      regionId: r.regionId,
      totalStaked: r.totalStakedWei.toString(),
    }));
  } else {
    // Fall back to current stake snapshot
    const response = await fetch(
      `${getControlApiUrl()}/wallets/address/${wallet}`
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Control API wallet fetch failed (${response.status}): ${text}`
      );
    }

    const data: any = await response.json();
    walletRegions = data?.regions || [];
  }

  const hasSteeringStake = walletRegions.some((r) => {
    try {
      return BigInt(r.totalStaked || "0") > BigInt(0);
    } catch {
      return false;
    }
  });

  const regionRewards = epoch
    ? await getRegionRewardsAtEpoch({ epoch })
    : await getCachedRegionRewards();
  const regionRewardById = new Map<
    number,
    { gctlStaked: bigint; glwRewardWei: bigint }
  >();
  for (const r of regionRewards.regionRewards || []) {
    regionRewardById.set(r.regionId, {
      gctlStaked: BigInt(r.gctlStaked || "0"),
      glwRewardWei: BigInt(r.glwReward || "0"),
    });
  }

  // Compute "GLW steered" per week as the wallet's share of the regional GLW rewards
  let steeredGlwWeiPerWeek = BigInt(0);
  const byRegion = new Map<number, bigint>();

  for (const r of walletRegions) {
    const walletStake = BigInt(r.totalStaked || "0");
    const region = regionRewardById.get(r.regionId);
    if (!region) continue;
    if (walletStake <= BigInt(0) || region.gctlStaked <= BigInt(0)) continue;

    const regionSteered =
      (region.glwRewardWei * walletStake) / region.gctlStaked;
    steeredGlwWeiPerWeek += regionSteered;
    byRegion.set(r.regionId, regionSteered);
  }

  return { steeredGlwWeiPerWeek, hasSteeringStake, byRegion };
}
