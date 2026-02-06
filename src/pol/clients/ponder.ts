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

export async function fetchPonderPolYield(params: {
  range: "90d";
}): Promise<PonderPolYieldResponse> {
  const base = getPonderBaseUrl();
  const url = `${base}/pol/yield?range=${encodeURIComponent(params.range)}`;
  return await fetchJson<PonderPolYieldResponse>(url);
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

