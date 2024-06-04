import { DB_DECIMALS } from "../../constants";

import { db } from "../../db/db";
import { eq } from "drizzle-orm";
import { farmRewards, FarmRewardsInsertType, farms } from "../../db/schema";
import { getScrapedFarmsAndRewards } from "./get-scraped-farms-and-rewards-for-week";

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

  const farmWithRewards: (FarmRewardsInsertType & {
    previousUsdgRewards: bigint;
    previousGlowRewards: bigint;
  })[] = farmsWithRewards.reduce((carry: any[], farm) => {
    const farmMatch = allFarmsIdsWithDevices.find(
      (dbFarm) =>
        dbFarm.devices.find((device) => device.shortId === farm.shortId) ||
        dbFarm.oldShortIds?.includes(farm.shortId)
    );

    if (farmMatch) {
      const hexlifiedFarmPubKey = farmMatch.id;
      return [
        ...carry,
        {
          hexlifiedFarmPubKey,
          weekNumber,
          usdgRewards:
            BigInt(Math.floor(farm.rewards.usdg)) * BigInt(DB_DECIMALS),
          glowRewards:
            BigInt(Math.floor(farm.rewards.glow)) * BigInt(DB_DECIMALS),
          previousUsdgRewards: farmMatch.totalUSDGRewards,
          previousGlowRewards: farmMatch.totalGlowRewards,
        },
      ];
    }
    console.log("No match found for farm", farm.shortId);
    return carry;
  }, []);

  if (farmWithRewards.length === 0) {
    return;
  }

  await db.transaction(async (trx) => {
    await Promise.all(
      farmWithRewards.map((farm) =>
        trx
          .update(farms)
          .set({
            totalUSDGRewards: farm.previousUsdgRewards + farm.usdgRewards!!,
            totalGlowRewards: farm.previousGlowRewards + farm.glowRewards!!,
          })
          .where(eq(farms.id, farm.hexlifiedFarmPubKey))
      )
    );

    await trx.insert(farmRewards).values(farmWithRewards);
  });
}
