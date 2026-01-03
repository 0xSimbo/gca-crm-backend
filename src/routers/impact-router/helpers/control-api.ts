import { addresses } from "../../../constants/addresses";

export interface ControlApiFarmReward {
  weekNumber: number;
  farmId: string;
  asset?: string | null;
  walletTotalGlowInflationReward?: string;
  walletInflationFromLaunchpad?: string;
  walletInflationFromMiningCenter?: string;
  walletProtocolDepositFromLaunchpad?: string;
  walletProtocolDepositFromMiningCenter?: string;
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
}

function getControlApiUrl(): string {
  if (!process.env.CONTROL_API_URL) {
    throw new Error("CONTROL_API_URL not configured");
  }
  return process.env.CONTROL_API_URL;
}

const CLAIMS_API_BASE_URL =
  "https://glow-ponder-listener-2-production.up.railway.app";

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

async function getCachedRegionRewards(
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

const UNCLAIMED_LAG_WEEKS = 3;

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

async function getRegionRewardsAtEpoch(params: {
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
  walletAddress: string
): Promise<UnclaimedGlwRewardsResult> {
  const wallet = walletAddress.toLowerCase();

  // 1) Total claimable GLW rewards from Control API weekly rewards table (GLW currency only)
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
  const maxWeek = rewards.reduce((max, r) => {
    const w = Number(r?.weekNumber ?? -1);
    return Number.isFinite(w) && w > max ? w : max;
  }, -1);
  const claimableEndWeek = maxWeek >= 0 ? maxWeek - UNCLAIMED_LAG_WEEKS : -1;

  let claimableGlwWei = BigInt(0);
  for (const r of rewards) {
    const weekNumber = Number(r?.weekNumber ?? -1);
    if (!Number.isFinite(weekNumber)) continue;
    if (weekNumber > claimableEndWeek) continue;
    claimableGlwWei += BigInt(r?.glowInflationTotal || "0");
    claimableGlwWei += BigInt(r?.protocolDepositRewardsReceived || "0");
  }

  // 2) Claimed GLW from claims API (on-chain claim events)
  const claimsResp = await fetch(
    `${CLAIMS_API_BASE_URL}/rewards/claims/${wallet}?limit=5000`
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

  const glwToken = addresses.glow.toLowerCase();
  const claims: any[] = claimsData?.claims || [];

  let claimedGlwWei = BigInt(0);
  for (const claim of claims) {
    const token = (claim?.token || "").toLowerCase();
    if (token !== glwToken) continue;
    claimedGlwWei += BigInt(claim?.amount || "0");
  }

  const unclaimed = claimableGlwWei - claimedGlwWei;
  return {
    amountWei: unclaimed > BigInt(0) ? unclaimed : BigInt(0),
    dataSource: "claims-api+control-api",
  };
}

export async function getGctlSteeringByWeekWei(params: {
  walletAddress: string;
  startWeek: number;
  endWeek: number;
}): Promise<SteeringByWeekResult> {
  const { walletAddress, startWeek, endWeek } = params;

  const byWeek = new Map<number, bigint>();

  try {
    const walletStakeByEpoch = await getWalletStakeByEpoch({
      walletAddress,
      startWeek,
      endWeek,
    });

    for (let w = startWeek; w <= endWeek; w++) {
      const regionRewards = await getRegionRewardsAtEpoch({ epoch: w });
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
      for (const r of walletRegions) {
        const walletStakeWei = r.totalStakedWei;
        const region = regionRewardById.get(r.regionId);
        if (!region) continue;
        if (walletStakeWei <= BigInt(0) || region.gctlStaked <= BigInt(0))
          continue;
        steeredGlwWei +=
          (region.glwRewardWei * walletStakeWei) / region.gctlStaked;
      }

      byWeek.set(w, steeredGlwWei);
    }

    return { byWeek, dataSource: "control-api" };
  } catch (error) {
    const snapshot = await getSteeringSnapshot(walletAddress);
    for (let w = startWeek; w <= endWeek; w++)
      byWeek.set(w, snapshot.steeredGlwWeiPerWeek);
    return {
      byWeek,
      dataSource: "control-api",
      isFallback: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getSteeringSnapshot(
  walletAddress: string
): Promise<SteeringSnapshot> {
  const wallet = walletAddress.toLowerCase();
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
  const walletRegions: Array<{ regionId: number; totalStaked: string }> =
    data?.regions || [];
  const hasSteeringStake = walletRegions.some((r) => {
    try {
      return BigInt(r.totalStaked || "0") > BigInt(0);
    } catch {
      return false;
    }
  });

  const regionRewards = await getCachedRegionRewards();
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

  // Compute "GLW steered" per week as the wallet's share of the regional GLW rewards,
  // based on the wallet's current staked GCTL per region.
  //
  // NOTE: This uses *current* stake totals (not historical per-week stake snapshots).
  // Once stake-by-epoch data is available, we can compute this per week accurately.
  let steeredGlwWeiPerWeek = BigInt(0);
  for (const r of walletRegions) {
    const walletStake = BigInt(r.totalStaked || "0");
    const region = regionRewardById.get(r.regionId);
    if (!region) continue;
    if (walletStake <= BigInt(0) || region.gctlStaked <= BigInt(0)) continue;
    steeredGlwWeiPerWeek +=
      (region.glwRewardWei * walletStake) / region.gctlStaked;
  }

  return { steeredGlwWeiPerWeek, hasSteeringStake };
}
