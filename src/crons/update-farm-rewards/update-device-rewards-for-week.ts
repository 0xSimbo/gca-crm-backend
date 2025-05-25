import { db } from "../../db/db";
import {
  deviceRewardParent,
  deviceRewards,
  DeviceRewardsInsertType,
} from "../../db/schema";
import { DeviceLifetimeMetrics } from "./get-devices-lifetime-metrics";

export async function updateDeviceRewardsForWeek({
  deviceLifetimeMetrics,
  weekNumber,
}: {
  deviceLifetimeMetrics: DeviceLifetimeMetrics[];
  weekNumber: number;
}) {
  const hexkeysOnly = deviceLifetimeMetrics.map((device) => {
    return { id: device.hexlifiedPublicKey };
  });

  const values: DeviceRewardsInsertType[] = deviceLifetimeMetrics.flatMap(
    (device) => {
      const weekData = device.weeklyData.find(
        (w) => w.weekNumber === weekNumber
      );
      if (!weekData) return [];
      return [
        {
          weekNumber,
          usdgRewards: weekData.rewards.usdg.toString(),
          glowRewards: weekData.rewards.glow.toString(),
          hexlifiedFarmPubKey: device.hexlifiedPublicKey,
        },
      ];
    }
  );

  try {
    await db
      .insert(deviceRewardParent)
      .values(hexkeysOnly)
      .onConflictDoNothing();
    await db.insert(deviceRewards).values(values);
  } catch (e) {
    console.error("Failed to update device rewards", e);
  }
}
