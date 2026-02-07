import { fetchJson } from "./http";

function getControlApiUrl(): string {
  if (!process.env.CONTROL_API_URL) {
    throw new Error("CONTROL_API_URL not configured");
  }
  return process.env.CONTROL_API_URL;
}

export type ControlMintedEvent = {
  wallet: string;
  txId: string;
  epoch: number;
  amountRaw: string; // USDC6 atomic
  currency: "USDC" | string;
  gctlMinted: string; // GCTL 18 atomic
  ts: string; // ISO string
};

export type ControlMintedEventsResponse = {
  page: number;
  limit: number;
  events: ControlMintedEvent[];
};

export type ControlRegionsActiveSummaryResponse = {
  metadata: {
    epochs: number[];
    epochTimestamps: Record<string, number>;
    currentEpoch: number;
  };
  total: {
    totalGctlStaked: string;
    totalGlwRewards: string;
  };
  regions: Array<{
    id: number;
    name: string;
    code: string;
    slug: string;
    isUs: boolean;
    currentGctlStaked: string;
    glwRewardPerWeek: string;
    rewardShare: string;
    data: Array<{
      epoch: number;
      timestamp: number;
      gctlStaked: string;
      pendingUnstake: string;
      pendingRestakeOut: string;
      pendingRestakeIn: string;
      netPending: string;
      eventCount: number;
    }>;
  }>;
};

export async function fetchControlMintedEvents(params: {
  page: number;
  limit: number;
}): Promise<ControlMintedEventsResponse> {
  const base = getControlApiUrl();
  const url = `${base}/events/minted?page=${encodeURIComponent(
    String(params.page)
  )}&limit=${encodeURIComponent(String(params.limit))}`;
  return await fetchJson<ControlMintedEventsResponse>(url);
}

export async function fetchControlRegionsActiveSummary(params: {
  epochs: number;
}): Promise<ControlRegionsActiveSummaryResponse> {
  const base = getControlApiUrl();
  const url = `${base}/regions/active/summary?epochs=${encodeURIComponent(
    String(params.epochs)
  )}`;
  return await fetchJson<ControlRegionsActiveSummaryResponse>(url);
}

