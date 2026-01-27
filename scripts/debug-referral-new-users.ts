import pLimit from "p-limit";
import { db } from "../src/db/db";
import { impactLeaderboardCache, referrals } from "../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  computeGlowImpactScores,
  getCurrentWeekProjection,
} from "../src/routers/impact-router/helpers/impact-score";
import { getCurrentEpoch } from "../src/utils/getProtocolWeek";
import { formatPointsScaled6, glwWeiToPointsScaled6 } from "../src/routers/impact-router/helpers/points";

const INFLATION_POINTS_PER_GLW_SCALED6 = BigInt(1_000_000); // +1.0 per GLW
const STEERING_POINTS_PER_GLW_SCALED6 = BigInt(3_000_000); // +3.0 per GLW
const VAULT_BONUS_POINTS_PER_GLW_SCALED6 = BigInt(5_000); // +0.005 per GLW per week
const GLOW_WORTH_POINTS_PER_GLW_SCALED6 = BigInt(1_000); // +0.001 per GLW per week

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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function formatScaled6(value: bigint): string {
  return formatPointsScaled6(value);
}

async function main() {
  const limitRaw = getArgValue(process.argv, "--limit") ?? "50";
  const concurrencyRaw = getArgValue(process.argv, "--concurrency") ?? "6";
  const minPointsRaw = getArgValue(process.argv, "--minPoints") ?? "0";

  const limit = Math.max(1, Math.trunc(Number(limitRaw)));
  const concurrency = Math.max(1, Math.trunc(Number(concurrencyRaw)));
  const minPoints = parseScaled6(minPointsRaw);

  const allReferrals = await db
    .select({
      refereeWallet: referrals.refereeWallet,
      referrerWallet: referrals.referrerWallet,
      linkedAt: referrals.linkedAt,
    })
    .from(referrals);

  const refereeMeta = new Map<
    string,
    { referrerWallet: string; linkedAt: Date }
  >();
  for (const row of allReferrals) {
    const referee = row.refereeWallet.toLowerCase();
    if (!refereeMeta.has(referee)) {
      refereeMeta.set(referee, {
        referrerWallet: row.referrerWallet.toLowerCase(),
        linkedAt: row.linkedAt,
      });
    }
  }

  const referees = Array.from(refereeMeta.keys());
  if (referees.length === 0) {
    console.log("No referrals found.");
    return;
  }

  const lastWeekPointsByWallet = new Map<string, bigint>();
  if (referees.length > 0) {
    const lastWeekRows = await db
      .select({
        walletAddress: impactLeaderboardCache.walletAddress,
        lastWeekPoints: impactLeaderboardCache.lastWeekPoints,
      })
      .from(impactLeaderboardCache)
      .where(inArray(impactLeaderboardCache.walletAddress, referees));

    for (const row of lastWeekRows) {
      lastWeekPointsByWallet.set(
        row.walletAddress.toLowerCase(),
        parseScaled6(String(row.lastWeekPoints))
      );
    }
  }

  const candidates = referees.filter(
    (wallet) => (lastWeekPointsByWallet.get(wallet) || 0n) === 0n
  );

  if (candidates.length === 0) {
    console.log("No referees with 0 points last week.");
    return;
  }

  const currentWeek = getCurrentEpoch(Math.floor(Date.now() / 1000));
  const glowWorthByWallet = new Map<string, any>();
  for (const batch of chunk(candidates, 25)) {
    const scores = await computeGlowImpactScores({
      walletAddresses: batch,
      startWeek: currentWeek,
      endWeek: currentWeek,
      includeWeeklyBreakdown: false,
    });
    for (const score of scores) {
      glowWorthByWallet.set(score.walletAddress.toLowerCase(), score.glowWorth);
    }
  }

  const limitProjection = pLimit(concurrency);
  const rows = await Promise.all(
    candidates.map((wallet) =>
      limitProjection(async () => {
        const projection = await getCurrentWeekProjection(
          wallet,
          glowWorthByWallet.get(wallet)
        );
        const projectedBasePoints = parseScaled6(
          projection.projectedPoints.basePointsPreMultiplierScaled6
        );
        if (projectedBasePoints <= minPoints) return null;

        const inflationPts = glwWeiToPointsScaled6(
          BigInt(projection.projectedPoints.inflationGlwWei || "0"),
          INFLATION_POINTS_PER_GLW_SCALED6
        );
        const steeringPts = glwWeiToPointsScaled6(
          BigInt(projection.projectedPoints.steeringGlwWei || "0"),
          STEERING_POINTS_PER_GLW_SCALED6
        );
        const vaultPts = glwWeiToPointsScaled6(
          BigInt(projection.projectedPoints.delegatedGlwWei || "0"),
          VAULT_BONUS_POINTS_PER_GLW_SCALED6
        );
        const worthPts = glwWeiToPointsScaled6(
          BigInt(projection.projectedPoints.glowWorthWei || "0"),
          GLOW_WORTH_POINTS_PER_GLW_SCALED6
        );

        const meta = refereeMeta.get(wallet);
        return {
          referee: wallet,
          referrer: meta?.referrerWallet ?? "unknown",
          linkedAt: meta?.linkedAt?.toISOString() ?? "",
          lastWeekPoints: formatScaled6(
            lastWeekPointsByWallet.get(wallet) || 0n
          ),
          projectedBasePoints: formatScaled6(projectedBasePoints),
          inflationPoints: formatScaled6(inflationPts),
          steeringPoints: formatScaled6(steeringPts),
          vaultPoints: formatScaled6(vaultPts),
          worthPoints: formatScaled6(worthPts),
        };
      })
    )
  );

  const filtered = rows.filter(Boolean) as Array<NonNullable<typeof rows[number]>>;
  filtered.sort((a, b) =>
    parseScaled6(b.projectedBasePoints) > parseScaled6(a.projectedBasePoints) ? 1 : -1
  );

  const output = filtered.slice(0, limit);
  if (output.length === 0) {
    console.log("No referees matched the criteria.");
    return;
  }

  console.log(
    `Referees with 0 points last week and >${formatScaled6(minPoints)} points now: ${filtered.length}`
  );
  console.table(output);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
