import { db } from "../db";
import {
  Devices,
  FarmDatabaseInsertType,
  RewardSplits,
  RewardSplitsInsertType,
  farms,
} from "../schema";

export interface MigrationFarmData {
  auditor: string;
  auditor_percentage_glow_weight: number;
  auditor_percentage_usdc_weight: number;
  comments: string[] | null;
  glow_weight: number;
  payment_tx_hash: string;
  payout_wallet: string;
  protocol_fee: number;
  protocol_fee_payment_hash: string;
  short_id: number;
  timestamp_audited_completed: number;
  hexlified_public_key: string;
  installer_glow_fee_percent: number;
  installer_usdg_fee_percent: number;
  installer_wallet: string;
  old_short_ids: string[];
}

export const insertFarmWithDependencies = async (
  farmData: MigrationFarmData
) => {
  return db.transaction(async (tx) => {
    const farmId = await tx
      .insert(farms)
      .values({
        gcaId: "0xB2d687b199ee40e6113CD490455cC81eC325C496", // jared wallet address
        userId: farmData.installer_wallet,
        createdAt: new Date(),
        auditCompleteDate: new Date(
          farmData.timestamp_audited_completed * 1000
        ),
        protocolFee: BigInt(Math.floor(farmData.protocol_fee * 1e6)),
        protocolFeePaymentHash: farmData.protocol_fee_payment_hash,
        oldShortIds: farmData.old_short_ids,
      } as FarmDatabaseInsertType)
      .returning({ id: farms.id });

    if (!farmId.length) {
      tx.rollback();
    }

    const devicesInsert = await tx
      .insert(Devices)
      .values({
        publicKey: farmData.hexlified_public_key,
        shortId: farmData.short_id.toString(),
        farmId: farmId[0].id,
      })
      .returning({ id: Devices.id });

    if (!devicesInsert.length) {
      tx.rollback();
    }
    const rewardSplitsData = [
      {
        walletAddress: farmData.installer_wallet,
        glowSplitPercent: farmData.installer_glow_fee_percent,
        usdgSplitPercent: farmData.installer_usdg_fee_percent,
      },
      {
        walletAddress: farmData.payout_wallet,
        glowSplitPercent: parseFloat(
          (
            1 -
            farmData.installer_glow_fee_percent -
            farmData.auditor_percentage_glow_weight
          ).toFixed(2)
        ),
        usdgSplitPercent: parseFloat(
          (
            1 -
            farmData.installer_usdg_fee_percent -
            farmData.auditor_percentage_usdc_weight
          ).toFixed(2)
        ),
      },
      {
        walletAddress: farmData.auditor,
        glowSplitPercent: farmData.auditor_percentage_glow_weight,
        usdgSplitPercent: farmData.auditor_percentage_usdc_weight,
      },
    ];

    for (const rewardSplit of rewardSplitsData) {
      const rewardSplitInsert = await tx
        .insert(RewardSplits)
        .values({
          farmId: farmId[0].id,
          walletAddress: rewardSplit.walletAddress,
          glowSplitPercent: (rewardSplit.glowSplitPercent * 100).toString(),
          usdgSplitPercent: (rewardSplit.usdgSplitPercent * 100).toString(),
        } as RewardSplitsInsertType)
        .returning({ id: RewardSplits.id });

      if (!rewardSplitInsert.length) {
        tx.rollback();
      }
    }
  });
};
