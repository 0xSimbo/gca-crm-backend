export const ACTIVATION_THRESHOLD_SCALED6 = 100_000_000n;

export type ReferralSnapshot = {
  id: string;
  status: "pending" | "active" | "inactive";
  activationBonusAwarded: boolean;
  referrerWallet: string;
  refereeWallet: string;
};

export function getPostLinkBasePointsScaled6(params: {
  historicalBasePointsScaled6: bigint;
  basePointsThisWeekScaled6: bigint;
  activationStartWeek: number;
  endWeek: number;
}): bigint {
  const {
    historicalBasePointsScaled6,
    basePointsThisWeekScaled6,
    activationStartWeek,
    endWeek,
  } = params;
  if (endWeek < activationStartWeek) return 0n;
  return historicalBasePointsScaled6 + basePointsThisWeekScaled6;
}

export function findActivationCandidates(params: {
  referrals: ReferralSnapshot[];
  basePointsThisWeekByReferee: Map<string, bigint>;
  historicalBasePointsByReferee: Map<string, bigint>;
  activationStartWeekByReferee: Map<string, number>;
  endWeek: number;
  thresholdScaled6?: bigint;
}): Set<string> {
  const threshold = params.thresholdScaled6 ?? ACTIVATION_THRESHOLD_SCALED6;
  const candidates = new Set<string>();

  for (const ref of params.referrals) {
    if (ref.status !== "pending" || ref.activationBonusAwarded) continue;
    const refereeWallet = ref.refereeWallet.toLowerCase();
    const activationStartWeek =
      params.activationStartWeekByReferee.get(refereeWallet) ?? 0;
    const historical =
      params.historicalBasePointsByReferee.get(refereeWallet) || 0n;
    const baseThisWeek =
      params.basePointsThisWeekByReferee.get(refereeWallet) || 0n;
    const postLinkBasePoints = getPostLinkBasePointsScaled6({
      historicalBasePointsScaled6: historical,
      basePointsThisWeekScaled6: baseThisWeek,
      activationStartWeek,
      endWeek: params.endWeek,
    });

    if (postLinkBasePoints >= threshold) {
      candidates.add(ref.id);
    }
  }

  return candidates;
}

export function buildActiveReferralCountMap(params: {
  referrals: ReferralSnapshot[];
  activationCandidates: Set<string>;
}): Map<string, number> {
  const activeReferralCountMap = new Map<string, number>();
  for (const ref of params.referrals) {
    if (ref.status === "active" || params.activationCandidates.has(ref.id)) {
      const rw = ref.referrerWallet.toLowerCase();
      activeReferralCountMap.set(
        rw,
        (activeReferralCountMap.get(rw) || 0) + 1
      );
    }
  }
  return activeReferralCountMap;
}
