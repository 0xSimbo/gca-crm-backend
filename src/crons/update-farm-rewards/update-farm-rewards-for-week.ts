import { DB_DECIMALS } from "../../constants";
import { getTableConfig } from "drizzle-orm/pg-core";
import { db } from "../../db/db";
import { getTableColumns } from "drizzle-orm";
import {
  FarmDatabaseType,
  FarmRewards,
  FarmRewardsDatabaseType,
  Farms,
} from "../../db/schema";
import { getScrapedFarmsAndRewards } from "./get-scraped-farms-and-rewards-for-week";
import { sql } from "drizzle-orm";
export async function updateFarmRewardsForWeek({
  weekNumber,
}: {
  weekNumber: number;
}) {
  const farmColumns = getTableColumns(Farms);
  const farmTableConfig = getTableConfig(Farms);
  const farmsWithRewards = await getScrapedFarmsAndRewards({ weekNumber });
  const drizzleFarmType: FarmDatabaseType[] = farmsWithRewards.map((farm) => {
    return {
      id: farm.hexPubKey,
      totalGlowRewards:
        BigInt(Math.floor(farm.rewards.glow)) * BigInt(10 ** DB_DECIMALS),
      totalUSDGRewards:
        BigInt(Math.floor(farm.rewards.usdg)) * BigInt(10 ** DB_DECIMALS),
      shortId: Number(farm.shortId),
      // @0xSimbo double check here if i didn't break anything
      auditCompleteDate: farm.auditCompleteDate
        ? new Date(farm.auditCompleteDate.toString())
        : null,
      createdAt: new Date(),
      gcaId: null, // @0xSimbo and here if we can just do farm.payoutWallet
      farmOwnerId: null, // @0xSimbo and here if we can just do farm.installerWallet
    };
  });

  const farmWithRewards: FarmRewardsDatabaseType[] = farmsWithRewards.map(
    (farm) => {
      return {
        hexlifiedFarmPubKey: farm.hexPubKey,
        weekNumber,
        usdgRewards:
          BigInt(Math.floor(farm.rewards.usdg)) * BigInt(DB_DECIMALS),
        glowRewards:
          BigInt(Math.floor(farm.rewards.glow)) * BigInt(DB_DECIMALS),
      };
    }
  );

  //   const farmsWeeklyRewards

  //First we += all the farms
  await db.transaction(async (trx) => {
    const statement1 = await trx
      .insert(Farms)
      .values(drizzleFarmType)
      .onConflictDoUpdate({
        target: Farms.id,
        set: {
          totalGlowRewards: sql.raw(
            `${farmTableConfig.name}.total_glow_rewards + EXCLUDED.${Farms.totalGlowRewards.name}`
          ),
          totalUSDGRewards: sql.raw(
            `${farmTableConfig.name}.total_usdg_rewards + EXCLUDED.${Farms.totalUSDGRewards.name}`
          ),
        },
      });
    const statement2 = await trx.insert(FarmRewards).values(farmWithRewards);
  });

  //   await db.execute(statement1)
}
