import { Elysia, t } from "elysia";
import { and, eq, isNull, inArray, desc, gt } from "drizzle-orm";
import { db } from "../../db/db";
import { farms, applications } from "../../db/schema";
import { TAG } from "../../constants";
import { getCurrentWeekProjection } from "../impact-router/helpers/impact-score";
import { getCurrentEpoch } from "../../utils/getProtocolWeek";
import { computeTotalWattsCaptured } from "./helpers/compute-watts";

const WATTS_PER_PANEL = 400;

export const solarCollectorRouter = new Elysia({ prefix: "/solar-collector" })
  .get(
    "/stats",
    async ({ query: { walletAddress, includeCurrentWeekPower }, set }) => {
      try {
        const wallet = walletAddress.toLowerCase();
        const shouldIncludeCurrentWeekPower =
          includeCurrentWeekPower === "1" || includeCurrentWeekPower === "true";
        const powerEndWeek = shouldIncludeCurrentWeekPower
          ? getCurrentEpoch()
          : undefined;

        // 1. Compute total Watts on-the-fly based on historical performance
        const {
          totalWatts,
          wattsByRegion,
          powerByRegion,
          strongholdRegionId,
          recentDrop,
          weeklyHistory,
          weeklyPowerHistory,
        } = await computeTotalWattsCaptured(wallet, {
          powerEndWeek,
        });

        // 2. Get impact score projection for streak and multiplier info
        const projection = await getCurrentWeekProjection(wallet);

        const panels = Math.floor(totalWatts / WATTS_PER_PANEL);
        const currentGhostWatts = totalWatts % WATTS_PER_PANEL;
        const ghostProgress = (currentGhostWatts / WATTS_PER_PANEL) * 100;

        // Streak logic:
        // - If action was taken THIS week, show the updated streak count
        // - If no action yet this week, show the streak from previous week (still valid until week ends)
        // - "at risk" = had a streak last week but haven't taken action THIS week yet
        const displayStreak = projection.hasImpactActionThisWeek
          ? projection.impactStreakWeeks
          : projection.streakAsOfPreviousWeek;
        const atRisk =
          projection.streakAsOfPreviousWeek > 0 &&
          !projection.hasImpactActionThisWeek;
        const isActive = displayStreak > 0 || projection.totalMultiplier > 1;

        const panelsByRegion: Record<number, number> = {};
        for (const [rid, watts] of Object.entries(wattsByRegion)) {
          panelsByRegion[Number(rid)] = Math.floor(watts / WATTS_PER_PANEL);
        }

        // Stronghold data (if exists)
        const stronghold = strongholdRegionId
          ? {
              regionId: strongholdRegionId,
              userPower: powerByRegion[strongholdRegionId]?.userPower || 0,
              totalNetworkPower:
                powerByRegion[strongholdRegionId]?.totalNetworkPower || 0,
              powerPercentile:
                powerByRegion[strongholdRegionId]?.powerPercentile || 0,
              rank: powerByRegion[strongholdRegionId]?.rank || 0,
              totalWallets:
                powerByRegion[strongholdRegionId]?.totalWallets || 0,
            }
          : null;

        return {
          totalWatts,
          wattsByRegion,
          panelsByRegion,
          panels,
          ghostProgress,
          streakStatus: {
            weeks: displayStreak,
            isActive,
            atRisk,
            multiplier: projection.totalMultiplier,
          },
          stronghold,
          recentDrop,
          weeklyHistory,
          weeklyPowerHistory,
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Internal Server Error";
      }
    },
    {
      query: t.Object({
        walletAddress: t.String({ pattern: "^0x[a-fA-F0-9]{40}$" }),
        includeCurrentWeekPower: t.Optional(t.String()),
      }),
      detail: {
        summary: "Get Solar Collector stats for a wallet",
        tags: [TAG.SOLAR_COLLECTOR],
      },
    }
  )
  .get(
    "/unseen-drops",
    async ({ query: { walletAddress }, set }) => {
      // Simplified: Just return the latest farm if it's very recent (last 7 days)
      // In a real stateless system, we can't track "seen" status without DB storage.
      // For MVP, we'll return the latest farm and let the frontend handle "seen" state in localStorage.
      try {
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const recentFarms = await db.query.farms.findMany({
          where: gt(farms.createdAt, oneWeekAgo),
          orderBy: desc(farms.createdAt),
          limit: 1,
        });

        // If no recent farms, return empty
        if (recentFarms.length === 0) return { unseenDrops: [] };

        const latestFarm = recentFarms[0];

        // We can optionally check if the user has a score > 0 to qualify for the drop
        const wallet = walletAddress.toLowerCase();
        const { totalWatts } = await computeTotalWattsCaptured(wallet);
        if (totalWatts <= 0) return { unseenDrops: [] };

        // Calculate the watts they captured from this specific farm
        // This is a bit inefficient to re-run, but for MVP stats endpoint it's okay.
        // For optimization, we could return this data from `computeTotalWattsCaptured`.

        // Simplified response for now
        return {
          unseenDrops: [
            {
              id: 1, // Mock ID since we don't have allocation rows
              farmId: latestFarm.id,
              farmName: latestFarm.name,
              wattsCaptured: 0, // Frontend will show generic message or we recalc specific share
              timestamp: latestFarm.createdAt,
            },
          ],
        };
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Internal Server Error";
      }
    },
    {
      query: t.Object({
        walletAddress: t.String({ pattern: "^0x[a-fA-F0-9]{40}$" }),
      }),
      detail: {
        summary: "Get recent farm drops for a wallet (Stateless)",
        tags: [TAG.SOLAR_COLLECTOR],
      },
    }
  )
  .post(
    "/mark-drops-seen",
    async ({ body: { walletAddress, dropIds }, set }) => {
      // Stateless: Client side handles the "seen" logic in localStorage
      return { success: true };
    },
    {
      body: t.Object({
        walletAddress: t.String({ pattern: "^0x[a-fA-F0-9]{40}$" }),
        dropIds: t.Array(t.Number()),
      }),
      detail: {
        summary: "Mark farm drops as seen (Placeholder)",
        tags: [TAG.SOLAR_COLLECTOR],
      },
    }
  );
