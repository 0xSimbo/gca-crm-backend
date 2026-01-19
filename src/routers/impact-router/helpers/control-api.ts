import { getCurrentEpoch } from "../../../utils/getProtocolWeek";

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

interface GlwBalanceSnapshotByWeekResponse {
  indexingComplete?: boolean;
  weekRange?: { startWeek: number; endWeek: number };
  results?: Array<{
    wallet: string;
    weeks: Array<{
      weekNumber: number;
      balanceWei: string;
      balanceGlw: string;
      source: "snapshot" | "current" | "forward_fill";
    }>;
  }>;
  error?: string;
}

export async function fetchGlwBalanceSnapshotByWeekBatch(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, Map<number, bigint>>> {
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

  const result = new Map<string, Map<number, bigint>>();
  for (const row of data.results || []) {
    const wallet = (row.wallet || "").toLowerCase();
    if (!wallet) continue;
    if (!result.has(wallet)) result.set(wallet, new Map());
    const byWeek = result.get(wallet)!;
    for (const w of row.weeks || []) {
      const weekNumber = Number(w.weekNumber);
      if (!Number.isFinite(weekNumber)) continue;
      try {
        byWeek.set(weekNumber, BigInt(w.balanceWei || "0"));
      } catch {
        byWeek.set(weekNumber, BigInt(0));
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
}): Promise<Map<string, Map<number, bigint>>> {
  const {
    wallets,
    startWeek,
    endWeek,
    batchSize = 500,
    concurrentBatches = 3,
  } = params;
  const result = new Map<string, Map<number, bigint>>();
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
    const batchPromises: Array<Promise<Map<string, Map<number, bigint>>>> = [];

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
        for (const [week, balanceWei] of byWeek) acc.set(week, balanceWei);
      }
    }
  }

  return result;
}

interface RegionRewardsResponse {
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
  const { wallets, startWeek, endWeek } = params;
  const result = new Map<string, ControlApiFarmReward[]>();
  if (wallets.length === 0) return result;

  const response = await fetch(
    `${getControlApiUrl()}/farms/by-wallet/farm-rewards-history/batch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets, startWeek, endWeek }),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Control API batch wallet rewards failed (${response.status}): ${text}`
    );
  }

  const data = (await response.json()) as ControlApiBatchWalletRewardsResponse;
  const results = data.results || {};
  for (const wallet of wallets) {
    const walletData = results[wallet];
    if (!walletData?.farmRewards) continue;
    result.set(wallet.toLowerCase(), walletData.farmRewards);
  }

  return result;
}

export async function fetchDepositSplitsHistoryBatch(params: {
  wallets: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, ControlApiDepositSplitHistorySegment[]>> {
  const { wallets, startWeek, endWeek } = params;
  const result = new Map<string, ControlApiDepositSplitHistorySegment[]>();
  if (wallets.length === 0) return result;

  const response = await fetch(
    `${getControlApiUrl()}/farms/by-wallet/deposit-splits-history/batch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallets, startWeek, endWeek }),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Control API batch deposit splits history failed (${response.status}): ${text}`
    );
  }

  const data =
    (await response.json()) as ControlApiBatchDepositSplitsHistoryResponse;
  const results = data.results || {};
  for (const wallet of wallets) {
    const rows = results[wallet] || results[wallet.toLowerCase()];
    if (!rows) continue;
    result.set(wallet.toLowerCase(), rows);
  }

  return result;
}

export async function fetchFarmRewardsHistoryBatch(params: {
  farmIds: string[];
  startWeek: number;
  endWeek: number;
}): Promise<Map<string, ControlApiFarmRewardsHistoryRewardRow[]>> {
  const { farmIds, startWeek, endWeek } = params;
  const result = new Map<string, ControlApiFarmRewardsHistoryRewardRow[]>();
  if (farmIds.length === 0) return result;

  const response = await fetch(
    `${getControlApiUrl()}/farms/rewards-history/batch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ farmIds, startWeek, endWeek }),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Control API batch farm rewards history failed (${response.status}): ${text}`
    );
  }

  const data =
    (await response.json()) as ControlApiBatchFarmRewardsHistoryResponse;
  const results = data.results || {};
  for (const farmId of farmIds) {
    const row = results[farmId];
    if (!row?.rewards) continue;
    result.set(farmId, row.rewards);
  }

  return result;
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

export async function getRegionRewardsAtEpoch(params: {
  epoch: number;
  ttlMs?: number;
}): Promise<RegionRewardsResponse> {
  const { epoch, ttlMs = 30_000 } = params;
  const now = Date.now();
  const cached = cachedRegionRewardsByEpoch.get(epoch);
  if (cached && now < cached.expiresAtMs) return cached.data;

  const response = await fetch(
    `${getControlApiUrl()}/regions/rewards/glw/regions?epoch=${epoch}`
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Control API region rewards (epoch=${epoch}) failed (${response.status}): ${text}`
    );
  }
  const data = (await response.json()) as RegionRewardsResponse;
  cachedRegionRewardsByEpoch.set(epoch, { data, expiresAtMs: now + ttlMs });
  return data;
}

async function getWalletStakeByEpoch(params: {
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
    throw new Error(
      `Control API wallet stake-by-epoch failed (${response.status}): ${text}`
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
}): Promise<SteeringByWeekResult> {
  const { walletAddress, startWeek, endWeek } = params;

  const byWeek = new Map<number, bigint>();
  const byWeekAndRegion = new Map<number, Map<number, bigint>>();

  try {
    // Fetch wallet stake and all region rewards in parallel
    const weeks = Array.from({ length: endWeek - startWeek + 1 }, (_, i) => startWeek + i);
    const [walletStakeByEpoch, ...regionRewardsResults] = await Promise.all([
      getWalletStakeByEpoch({ walletAddress, startWeek, endWeek }),
      ...weeks.map((w) => getRegionRewardsAtEpoch({ epoch: w })),
    ]);

    // Build a map of week -> region rewards
    const regionRewardsByWeek = new Map<number, RegionRewardsResponse>();
    weeks.forEach((w, i) => regionRewardsByWeek.set(w, regionRewardsResults[i]));

    for (let w = startWeek; w <= endWeek; w++) {
      const regionRewards = regionRewardsByWeek.get(w)!;
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
