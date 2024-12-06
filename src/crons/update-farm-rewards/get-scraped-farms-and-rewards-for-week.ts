import { formatUnits } from "viem";
import { getRewardsInBucket } from "../../lib/web3-view/get-rewards-in-bucket";
import { type Farm } from "../../types/api-types/Farm";

type ApiRes = {
  filteredFarms: Farm[];
};

const TOTAL_GLOW_REWARDS = 175_000;

type FarmWithWeightsAndRewards = Farm & {
  rewards: {
    glow: number;
    usdg: number;
  };
  weights: {
    glow: number;
    usdg: number;
  };
};
async function scrapeFarms({
  weekNumber,
}: {
  weekNumber: number;
}): Promise<Farm[]> {
  const body = {
    urls: ["http://95.217.194.59:35015"],
    week_number: weekNumber,
    with_full_data: true,
    with_raw_data: true,
  };
  const url = `https://fun-rust-production.up.railway.app/headline_farm_stats`;

  const post = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const resSon = (await post.json()) as ApiRes;
  return resSon.filteredFarms;
}
const transformFarmsToFarmsAndRewards = (
  farms: Farm[],
  totalUSDGRewards: number
): FarmWithWeightsAndRewards[] => {
  let totalCreditsProduced = 0;
  let totalProtocolFeesPaid = 0;

  for (const farm of farms) {
    totalCreditsProduced += farm.carbonCreditsProduced;
    totalProtocolFeesPaid += farm.weeklyPayment;
  }

  const farmsWithWeightsAndRewards: FarmWithWeightsAndRewards[] = farms.map(
    (farm: Farm) => {
      const usdg =
        (farm.carbonCreditsProduced / totalCreditsProduced) * totalUSDGRewards;

      const glow =
        (farm.weeklyPayment / totalProtocolFeesPaid) * TOTAL_GLOW_REWARDS;

      return {
        ...farm,
        rewards: {
          glow,
          usdg,
        },
        weights: {
          glow: farm.carbonCreditsProduced,
          usdg: farm.weeklyPayment,
        },
      };
    }
  );

  return farmsWithWeightsAndRewards;
};
export async function getScrapedFarmsAndRewards({
  weekNumber,
}: {
  weekNumber: number;
}) {
  //We need to subtract 1 when we scrape the farms since the data for report (x) is from week (x-1)
  const farms = await scrapeFarms({ weekNumber: weekNumber - 1 });
  const rewardsInBucketBigNumber = await getRewardsInBucket(weekNumber);

  const rewardsInBucket = formatUnits(rewardsInBucketBigNumber as bigint, 6);
  const farmsWithRewards = transformFarmsToFarmsAndRewards(
    farms,
    parseFloat(rewardsInBucket)
  );

  //Const farms with hex pub key and rewards only and short id
  const minimalData = farmsWithRewards.map((farm) => {
    return {
      hexPubKey: farm.hexlifiedPublicKey,
      rewards: farm.rewards,
      shortId: farm.shortId.toString(),
      auditCompleteDate: farm.timestampAuditedComplete,
      rewardSplits: farm.rewardSplits,
    };
  });
  return minimalData;
}
