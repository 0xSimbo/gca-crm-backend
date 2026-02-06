import { fetchJson } from "./http";

function getWeeklyReportBaseUrl(): string {
  // Public R2 base where the immutable per-week reports are published.
  // Example: `${base}/weekly-report-week-112.json`
  return (
    process.env.WEEKLY_REPORT_BASE_URL?.trim() ||
    "https://pub-311748c72106476cbeabe0a22a59217d.r2.dev"
  );
}

export type WeeklyReportControlMintedEvent = {
  txId: string;
  logIndex: number;
  epoch: number;
  wallet: string;
  amountRaw: string; // USDG/USDC6 atomic
  currency: string;
  gctlMinted: string; // GCTL atomic (as provided by Control/weekly report)
  priceUsdc?: string;
  ts: string; // ISO string
};

export type WeeklyReportZoneStakeRow = [
  number,
  {
    totalStaked: string;
    totalStakedAndNotUsedInProtocolFees?: string;
    pendingUnstake?: string;
    pendingRestakeIn?: string;
    pendingRestakeOut?: string;
  },
];

export type WeeklyReport = {
  week: number;
  controlMintedEvents: WeeklyReportControlMintedEvent[];
  zoneStakeMap: WeeklyReportZoneStakeRow[];

  // The report contains many other fields, which we intentionally ignore here.
  [key: string]: unknown;
};

export async function fetchWeeklyReportWeek(params: {
  weekNumber: number;
}): Promise<WeeklyReport> {
  const base = getWeeklyReportBaseUrl();
  const url = `${base}/weekly-report-week-${params.weekNumber}.json`;
  return await fetchJson<WeeklyReport>(url);
}

