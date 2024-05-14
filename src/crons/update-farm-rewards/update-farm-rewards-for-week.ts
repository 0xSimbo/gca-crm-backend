import { DB_DECIMALS } from "../../constants";
import { getTableConfig } from "drizzle-orm/pg-core";
import { db } from "../../db/db";
import { getTableColumns } from "drizzle-orm";
import {
  FarmDatabaseType,
  farmRewards,
  FarmRewardsDatabaseType,
  farms,
} from "../../db/schema";
import { getScrapedFarmsAndRewards } from "./get-scraped-farms-and-rewards-for-week";
import { sql } from "drizzle-orm";
export async function updateFarmRewardsForWeek({
  weekNumber,
}: {
  weekNumber: number;
}) {
  const farmColumns = getTableColumns(farms);
  const farmTableConfig = getTableConfig(farms);
  const farmsWithRewards = await getScrapedFarmsAndRewards({ weekNumber });

  const drizzleFarmType: FarmDatabaseType[] = farmsWithRewards.map((farm) => {
    return {
      id: farm.hexPubKey,
      totalGlowRewards:
        BigInt(Math.floor(farm.rewards.glow)) * BigInt(10 ** DB_DECIMALS),
      totalUSDGRewards:
        BigInt(Math.floor(farm.rewards.usdg)) * BigInt(10 ** DB_DECIMALS),
      shortId: Number(farm.shortId),
      auditCompleteDate: farm.auditCompleteDate
        ? new Date(Number(farm.auditCompleteDate))
        : new Date(),
      createdAt: new Date(),
      gcaId: farm.installerWallet,
      userId: farm.payoutWallet,
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
      .insert(farms)
      .values(drizzleFarmType)
      .onConflictDoUpdate({
        target: farms.id,
        set: {
          totalGlowRewards: sql.raw(
            `${farmTableConfig.name}.total_glow_rewards + EXCLUDED.${farms.totalGlowRewards.name}`
          ),
          totalUSDGRewards: sql.raw(
            `${farmTableConfig.name}.total_usdg_rewards + EXCLUDED.${farms.totalUSDGRewards.name}`
          ),
        },
      });
    const statement2 = await trx.insert(farmRewards).values(farmWithRewards);
  });

  //   await db.execute(statement1)
}
