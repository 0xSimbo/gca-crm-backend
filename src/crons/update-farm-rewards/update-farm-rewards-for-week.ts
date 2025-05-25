import fs from "fs";
import { DB_DECIMALS } from "../../constants";

import { db } from "../../db/db";
import { eq, sql } from "drizzle-orm";
import { farmRewards, FarmRewardsInsertType, farms } from "../../db/schema";
import {
  DeviceLifetimeMetrics,
  getDevicesLifetimeMetrics,
} from "./get-devices-lifetime-metrics";

// Helper function to convert BigInt to string in objects
// function replaceBigInts(obj: any): any {
//   return JSON.parse(
//     JSON.stringify(obj, (_, value) =>
//       typeof value === "bigint" ? value.toString() : value
//     )
//   );
// }

export async function updateFarmRewardsForWeek({
  deviceLifetimeMetrics,
  weekNumber,
}: {
  deviceLifetimeMetrics: DeviceLifetimeMetrics[];
  weekNumber: number;
}) {
  const allFarmsIdsWithDevices = await db.query.farms.findMany({
    columns: {
      id: true,
      totalGlowRewards: true,
      totalUSDGRewards: true,
      oldShortIds: true,
    },
    with: {
      devices: {
        columns: {
          shortId: true,
          publicKey: true,
        },
      },
    },
  });

  // Directly map DeviceLifetimeMetrics to farm rewards
  const farmWithRewards: (FarmRewardsInsertType & {
    previousUsdgRewards: bigint;
    previousGlowRewards: bigint;
  })[] = deviceLifetimeMetrics.flatMap((farm) => {
    const farmMatch = allFarmsIdsWithDevices.find((dbFarm) =>
      dbFarm.devices.some(
        (device) =>
          device.publicKey.toLowerCase() ===
          farm.hexlifiedPublicKey.toLowerCase()
      )
    );
    if (!farmMatch) return [];
    const hexlifiedFarmPubKey = farmMatch.id;
    // Find the week data for the given weekNumber
    const weekData = farm.weeklyData.find((w) => w.weekNumber === weekNumber);
    if (!weekData) return [];
    return [
      {
        hexlifiedFarmPubKey,
        weekNumber,
        usdgRewards:
          BigInt(Math.floor(weekData.rewards.usdg)) * BigInt(10 ** DB_DECIMALS),
        glowRewards:
          BigInt(Math.floor(weekData.rewards.glow)) * BigInt(10 ** DB_DECIMALS),
        previousUsdgRewards: farmMatch.totalUSDGRewards,
        previousGlowRewards: farmMatch.totalGlowRewards,
      },
    ];
  });

  // Deduplicate farm rewards by combining rewards for the same farm and week
  const deduplicatedFarmRewards = Object.values(
    farmWithRewards.reduce((acc, farm) => {
      const key = `${farm.hexlifiedFarmPubKey}-${farm.weekNumber}`;
      if (!acc[key]) {
        acc[key] = farm;
      } else {
        acc[key] = {
          ...acc[key],
          usdgRewards:
            (acc[key].usdgRewards ?? BigInt(0)) +
            (farm.usdgRewards ?? BigInt(0)),
          glowRewards:
            (acc[key].glowRewards ?? BigInt(0)) +
            (farm.glowRewards ?? BigInt(0)),
        };
      }
      return acc;
    }, {} as Record<string, (typeof farmWithRewards)[number]>)
  );

  if (deduplicatedFarmRewards.length === 0) return;

  await db.transaction(async (trx) => {
    await trx.insert(farmRewards).values(deduplicatedFarmRewards);
    await Promise.all(
      deduplicatedFarmRewards.map((farm) => {
        const usdgRewards = farm.usdgRewards ?? BigInt(0);
        const glowRewards = farm.glowRewards ?? BigInt(0);
        return trx
          .update(farms)
          .set({
            totalUSDGRewards: farm.previousUsdgRewards + usdgRewards,
            totalGlowRewards: farm.previousGlowRewards + glowRewards,
          })
          .where(eq(farms.id, farm.hexlifiedFarmPubKey));
      })
    );
  });
}
