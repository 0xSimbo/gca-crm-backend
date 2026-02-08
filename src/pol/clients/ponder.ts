import { fetchJson } from "./http";

function getPonderBaseUrl(): string {
  // Plan: use CLAIMS_API_BASE_URL as canonical.
  // Fallback keeps older deployments working when env is missing.
  return (
    process.env.CLAIMS_API_BASE_URL ??
    "https://glow-ponder-listener-2-production.up.railway.app"
  );
}

export type PonderPolYieldResponse = {
  range: string;
  strategyReturns90dLq: string;
  uniFees90dLq: string;
  polStartLq: string;
  apy: string;
  yieldPerWeekLq: string;
  indexingComplete: boolean;
};

export type PonderPolSummaryResponse = {
  endowment: { usdg: string; glw: string; lq: string };
  botActive: { usdg: string; glw: string; lq: string };
  total: {
    lq: string;
    usd: string;
    breakdown: { usdg: string; glw: string };
  };
  spotPrice: string; // USDG per GLW (decimal string)
  indexingComplete: boolean;
};

export type PonderFmiSellPressureResponse = {
  range: string;
  weekRange: { startWeek: number; endWeek: number };
  series: Array<{
    week: number;
    sell: { glw: string; usdg: string; swaps: number };
    buy: { glw: string; usdg: string; swaps: number };
    net: { glw: string; usdg: string };
  }>;
  indexingComplete: boolean;
};

export type PonderSpotPriceResponse = {
  spotPrice: string; // USDG per GLW (6 decimals as string)
  blockNumber: string | null;
  timestamp: string | null;
  indexingComplete: boolean;
};

export type PonderPolPointsResponse = {
  from: number;
  to: number;
  range: string | null;
  interval: "sync" | "hour" | "day" | "week";
  points: Array<{
    timestamp: string; // unix seconds
    week: number; // protocol week for the point timestamp
    blockNumber: string;
    logIndex: string;
    spotPrice: string; // USDG per GLW (decimal string)
    endowment: {
      lpBalance: string;
      totalLpSupply: string;
      usdg: string;
      glw: string;
      lq: string;
    };
    botActive: {
      timestamp: string | null;
      tradeType: string | null;
      usdg: string;
      glw: string;
      lq: string;
    };
    total: {
      usdg: string;
      glw: string;
      lq: string;
    };
  }>;
  indexingComplete: boolean;
};

export async function fetchPonderPolYield(params: {
  range: "90d";
}): Promise<PonderPolYieldResponse> {
  const base = getPonderBaseUrl();
  const url = `${base}/pol/yield?range=${encodeURIComponent(params.range)}`;
  return await fetchJson<PonderPolYieldResponse>(url);
}

export async function fetchPonderPolSummary(): Promise<PonderPolSummaryResponse> {
  const base = getPonderBaseUrl();
  const url = `${base}/pol/summary`;
  return await fetchJson<PonderPolSummaryResponse>(url);
}

export async function fetchPonderFmiSellPressure(params: {
  range: string; // e.g. 12w
}): Promise<PonderFmiSellPressureResponse> {
  const base = getPonderBaseUrl();
  const url = `${base}/fmi/sell-pressure?range=${encodeURIComponent(
    params.range
  )}`;
  return await fetchJson<PonderFmiSellPressureResponse>(url);
}

export async function fetchPonderSpotPriceByTimestamp(params: {
  timestamp: number; // unix seconds
}): Promise<PonderSpotPriceResponse> {
  const base = getPonderBaseUrl();
  const url = `${base}/spot-price?timestamp=${encodeURIComponent(
    String(params.timestamp)
  )}`;
  return await fetchJson<PonderSpotPriceResponse>(url);
}

export async function fetchPonderPolPoints(params: {
  from: number;
  to: number;
  interval: "sync" | "hour" | "day" | "week";
  includePrior?: boolean;
  limit?: number;
}): Promise<PonderPolPointsResponse> {
  const base = getPonderBaseUrl();
  const qs = new URLSearchParams();
  qs.set("from", String(params.from));
  qs.set("to", String(params.to));
  qs.set("interval", params.interval);
  if (params.includePrior) qs.set("includePrior", "true");
  if (params.limit != null) qs.set("limit", String(params.limit));
  const url = `${base}/pol/points?${qs.toString()}`;
  return await fetchJson<PonderPolPointsResponse>(url);
}
