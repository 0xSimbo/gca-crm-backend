import { DB_DECIMALS } from "../../constants";

import { db } from "../../db/db";
import { eq, sql } from "drizzle-orm";
import {
  deviceRewardParent,
  deviceRewards,
  DeviceRewardsInsertType,
  farmRewards,
  FarmRewardsInsertType,
  farms,
} from "../../db/schema";
import { getScrapedFarmsAndRewards } from "./get-scraped-farms-and-rewards-for-week";

export async function updateDeviceRewardsForWeek({
  weekNumber,
}: {
  weekNumber: number;
}) {
  console.log("here!");
  const devicesWithRewards = await getScrapedFarmsAndRewards({ weekNumber });
  const hexkeysOnly = devicesWithRewards.map((device) => {
    return { id: device.hexPubKey };
  });

  const values: DeviceRewardsInsertType[] = devicesWithRewards.map((device) => {
    return {
      weekNumber,
      usdgRewards: device.rewards.usdg.toString(),
      glowRewards: device.rewards.glow.toString(),
      hexlifiedFarmPubKey: device.hexPubKey,
    };
  });

  try {
    await db
      .insert(deviceRewardParent)
      .values(hexkeysOnly)
      .onConflictDoNothing();
    await db.insert(deviceRewards).values(values);
  } catch (e) {
    console.log(e);
  }
}
