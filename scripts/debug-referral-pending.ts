import { db } from "../src/db/db";
import { referrals, referralPointsWeekly } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  applyPostLinkProration,
  calculateReferrerShare,
  getReferrerTier,
} from "../src/routers/impact-router/helpers/referral-points";
import {
  computeGlowImpactScores,
  getCurrentWeekProjection,
} from "../src/routers/impact-router/helpers/impact-score";
import { formatPointsScaled6 } from "../src/routers/impact-router/helpers/points";
import { dateToEpoch, getCurrentEpoch } from "../src/utils/getProtocolWeek";
import { getWeekRangeForImpact } from "../src/routers/fractions-router/helpers/apy-helpers";

const ACTIVATION_THRESHOLD_SCALED6 = 100_000_000n;

function getArgValue(argv: string[], key: string): string | undefined {
  const idx = argv.indexOf(key);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function parseScaled6(val: string | undefined): bigint {
  if (!val) return 0n;
  const raw = val.trim();
  if (!raw) return 0n;
  const isNeg = raw.startsWith("-");
  const abs = isNeg ? raw.slice(1) : raw;
  const parts = abs.split(".");
  if (parts.length > 2) return 0n;
  const intPartRaw = parts[0] ?? "";
  const fracRaw = parts[1] ?? "";

  const intPart = intPartRaw === "" ? "0" : intPartRaw;
  if (!/^\d+$/.test(intPart)) return 0n;
  if (fracRaw !== "" && !/^\d+$/.test(fracRaw)) return 0n;

  const frac = (fracRaw + "000000").slice(0, 6);
  let out = BigInt(intPart) * 1_000_000n + BigInt(frac);
  if (isNeg) out = -out;
  return out;
}

function formatScaled6(value: bigint): string {
  return formatPointsScaled6(value);
}

function logLine(label: string, value: string) {
  console.log(`${label}: ${value}`);
}

async function main() {
  const refereeArg =
    getArgValue(process.argv, "--referee") ??
    getArgValue(process.argv, "--wallet");
  const referrerArg = getArgValue(process.argv, "--referrer");

  if (!refereeArg) {
    throw new Error("Missing --referee <wallet> argument");
  }

  const refereeWallet = refereeArg.toLowerCase();
  const referrerWallet = referrerArg?.toLowerCase();

  const referralRecord = await db.query.referrals.findFirst({
    where: (r, { eq, sql }) =>
      eq(sql`lower(${r.refereeWallet})`, refereeWallet),
  });

  if (!referralRecord) {
    throw new Error(`No referral record found for referee ${refereeWallet}`);
  }

  const resolvedReferrer =
    referrerWallet ?? referralRecord.referrerWallet.toLowerCase();

  const currentWeek = getCurrentEpoch(Math.floor(Date.now() / 1000));
  const activationStartWeek = dateToEpoch(referralRecord.linkedAt);

  const projection = await getCurrentWeekProjection(refereeWallet);
  const projectedBasePointsRaw = parseScaled6(
    projection.projectedPoints.basePointsPreMultiplierScaled6
  );
  const projectedBasePointsProrated = applyPostLinkProration({
    basePointsScaled6: projectedBasePointsRaw,
    linkedAt: referralRecord.linkedAt,
    weekNumber: currentWeek,
  });

  const { startWeek, endWeek } = getWeekRangeForImpact();
  const referrerScore = await computeGlowImpactScores({
    walletAddresses: [resolvedReferrer],
    startWeek,
    endWeek,
    includeWeeklyBreakdown: false,
  });
  const referrerBasePointsScaled6 = parseScaled6(
    referrerScore[0]?.totals.basePointsPreMultiplierScaled6
  );

  const activeCountRes = await db
    .select({
      activeReferees: sql<number>`count(*) filter (where ${referrals.status} = 'active')::int`,
      pendingReferees: sql<number>`count(*) filter (where ${referrals.status} = 'pending')::int`,
      totalReferees: sql<number>`count(*)::int`,
    })
    .from(referrals)
    .where(eq(referrals.referrerWallet, resolvedReferrer));

  const activeReferees = Number(activeCountRes[0]?.activeReferees || 0);
  const pendingReferees = Number(activeCountRes[0]?.pendingReferees || 0);
  const totalReferees = Number(activeCountRes[0]?.totalReferees || 0);

  const tier = getReferrerTier(activeReferees, referrerBasePointsScaled6);
  const tierIncludingPending = getReferrerTier(
    Math.max(totalReferees, 1),
    referrerBasePointsScaled6
  );

  const historicalBasePointsRows = await db
    .select({
      weekNumber: referralPointsWeekly.weekNumber,
      basePoints: referralPointsWeekly.refereeBasePointsScaled6,
    })
    .from(referralPointsWeekly)
    .where(eq(referralPointsWeekly.refereeWallet, refereeWallet));

  let historicalPostLinkBasePoints = 0n;
  for (const row of historicalBasePointsRows) {
    if (row.weekNumber < activationStartWeek) continue;
    const basePoints = parseScaled6(row.basePoints);
    if (basePoints <= 0n) continue;
    historicalPostLinkBasePoints += basePoints;
  }

  const includeProjected = currentWeek >= activationStartWeek;
  const postLinkBasePoints =
    historicalPostLinkBasePoints +
    (includeProjected ? projectedBasePointsProrated : 0n);
  const activationPending =
    referralRecord.status === "pending" &&
    includeProjected &&
    postLinkBasePoints >= ACTIVATION_THRESHOLD_SCALED6;

  const projectedShareActiveOnly = calculateReferrerShare(
    projectedBasePointsProrated,
    activeReferees,
    referrerBasePointsScaled6
  );
  const projectedShareIncludingPending = calculateReferrerShare(
    projectedBasePointsProrated,
    Math.max(totalReferees, 1),
    referrerBasePointsScaled6
  );
  const projectedActiveCountWithPending = activeReferees + (activationPending ? 1 : 0);
  const projectedShareWithPending = calculateReferrerShare(
    projectedBasePointsProrated,
    projectedActiveCountWithPending,
    referrerBasePointsScaled6
  );

  console.log("Referral Pending Points Debug");
  console.log("=".repeat(36));
  logLine("Referee", refereeWallet);
  logLine("Referrer", resolvedReferrer);
  logLine("Status", referralRecord.status);
  logLine("Linked At", referralRecord.linkedAt.toISOString());
  logLine("Current Week", `${currentWeek}`);
  logLine("Activation Start Week", `${activationStartWeek}`);
  logLine("Referrer Base Points", `${formatScaled6(referrerBasePointsScaled6)} (${referrerBasePointsScaled6} scaled6)`);
  logLine("Active Referees", `${activeReferees}`);
  logLine("Pending Referees", `${pendingReferees}`);
  logLine("Total Referees", `${totalReferees}`);
  logLine(
    "Tier Used",
    `${tier.name} (${tier.percent}%)${referrerBasePointsScaled6 > 0n ? "" : " [GATED]"}`
  );
  logLine(
    "Tier Used (incl pending)",
    `${tierIncludingPending.name} (${tierIncludingPending.percent}%)${
      referrerBasePointsScaled6 > 0n ? "" : " [GATED]"
    }`
  );
  logLine(
    "Projected Base Points (raw)",
    `${formatScaled6(projectedBasePointsRaw)} (${projectedBasePointsRaw} scaled6)`
  );
  logLine(
    "Projected Base Points (prorated)",
    `${formatScaled6(projectedBasePointsProrated)} (${projectedBasePointsProrated} scaled6)`
  );
  logLine(
    "Historical Post-Link Base Points",
    `${formatScaled6(historicalPostLinkBasePoints)} (${historicalPostLinkBasePoints} scaled6)`
  );
  logLine(
    "Post-Link Base Points (with projection)",
    `${formatScaled6(postLinkBasePoints)} (${postLinkBasePoints} scaled6)`
  );
  logLine("Activation Pending", activationPending ? "yes" : "no");
  logLine(
    "Pending Share (active only)",
    `${formatScaled6(projectedShareActiveOnly)} (${projectedShareActiveOnly} scaled6)`
  );
  logLine(
    "Pending Share (incl pending)",
    `${formatScaled6(projectedShareIncludingPending)} (${projectedShareIncludingPending} scaled6)`
  );
  logLine(
    "Pending Share (if activates)",
    `${formatScaled6(projectedShareWithPending)} (${projectedShareWithPending} scaled6)`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
