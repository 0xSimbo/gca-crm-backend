// This file was generated by [ts-rs](https://github.com/Aleph-Alpha/ts-rs). Do not edit this file manually.
import type { FarmStatus } from "./FarmStatus";
import type { SlotRange } from "./SlotRange";

export interface Farm {
  hexlifiedPublicKey: string;
  carbonCreditsProduced: number;
  powerOutputs: Array<number>;
  impactRates: Array<number>;
  weeklyPayment: number;
  rollingImpactPoints: number;
  powerOutput: number;
  shortId: bigint;
  protocolFee: number;
  payoutWallet: string;
  installerWallet: string;
  installerGlowFeePercent: number;
  installerUsdgFeePercent: number;
  status: FarmStatus;
  protocolFeePaymentHash: string | null;
  weeksAndSlotRangesToInvertPowerMap: Record<number, Array<SlotRange>> | null;
  weeksAndSlotsToInvalidatePowerMap: Record<number, Array<SlotRange>> | null;
  timestampAuditedComplete: bigint | null;
}