import fs from "fs";
import { DB_DECIMALS } from "../../constants";

import { db } from "../../db/db";
import { eq, sql } from "drizzle-orm";
import { farmRewards, FarmRewardsInsertType, farms } from "../../db/schema";
import { getScrapedFarmsAndRewards } from "./get-scraped-farms-and-rewards-for-week";

// Helper function to convert BigInt to string in objects
// function replaceBigInts(obj: any): any {
//   return JSON.parse(
//     JSON.stringify(obj, (_, value) =>
//       typeof value === "bigint" ? value.toString() : value
//     )
//   );
// }

export async function updateFarmRewardsForWeek({
  weekNumber,
}: {
  weekNumber: number;
}) {
  const farmsWithRewards = await getScrapedFarmsAndRewards({ weekNumber });

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

  // fs.writeFileSync(
  //   `./src/crons/update-farm-rewards/logs/farmsWithRewards-${weekNumber}.json`,
  //   JSON.stringify(replaceBigInts(farmsWithRewards), null, 2)
  // );

  // fs.writeFileSync(
  //   `./src/crons/update-farm-rewards/logs/allFarmsIdsWithDevices-${weekNumber}.json`,
  //   JSON.stringify(replaceBigInts(allFarmsIdsWithDevices), null, 2)
  // );

  const farmWithRewards: (FarmRewardsInsertType & {
    previousUsdgRewards: bigint;
    previousGlowRewards: bigint;
  })[] = farmsWithRewards.reduce((carry: any[], farm) => {
    const farmMatch = allFarmsIdsWithDevices.find((dbFarm) =>
      dbFarm.devices.find(
        (device) =>
          device.publicKey.toLowerCase() === farm.hexPubKey.toLowerCase()
      )
    );

    if (farmMatch) {
      const hexlifiedFarmPubKey = farmMatch.id;
      return [
        ...carry,
        {
          hexlifiedFarmPubKey,
          weekNumber,
          usdgRewards:
            BigInt(Math.floor(farm.rewards.usdg)) * BigInt(10 ** DB_DECIMALS),
          glowRewards:
            BigInt(Math.floor(farm.rewards.glow)) * BigInt(10 ** DB_DECIMALS),
          previousUsdgRewards: farmMatch.totalUSDGRewards,
          previousGlowRewards: farmMatch.totalGlowRewards,
        },
      ];
    }
    // console.log("No match found for farm", farm.shortId);
    return carry;
  }, []);

  // Deduplicate farm rewards by combining rewards for the same farm and week
  const deduplicatedFarmRewards = Object.values(
    farmWithRewards.reduce((acc, farm) => {
      const key = `${farm.hexlifiedFarmPubKey}-${farm.weekNumber}`;

      if (!acc[key]) {
        acc[key] = farm;
      } else {
        // Combine rewards if there are multiple entries for the same farm
        acc[key] = {
          ...acc[key],
          usdgRewards: acc[key].usdgRewards!! + farm.usdgRewards!!,
          glowRewards: acc[key].glowRewards!! + farm.glowRewards!!,
        };
      }

      return acc;
    }, {} as Record<string, (typeof farmWithRewards)[number]>)
  );

  if (deduplicatedFarmRewards.length === 0) {
    return;
  }

  await db.transaction(async (trx) => {
    await trx.insert(farmRewards).values(deduplicatedFarmRewards);

    await Promise.all(
      deduplicatedFarmRewards.map((farm) =>
        trx
          .update(farms)
          .set({
            totalUSDGRewards: farm.previousUsdgRewards + farm.usdgRewards!!,
            totalGlowRewards: farm.previousGlowRewards + farm.glowRewards!!,
          })
          .where(eq(farms.id, farm.hexlifiedFarmPubKey))
      )
    );
  });
}
