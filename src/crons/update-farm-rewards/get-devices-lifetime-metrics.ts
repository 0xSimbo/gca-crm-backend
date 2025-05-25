// Updated types to match new API response
interface DeviceWeeklyData {
  weekNumber: number;
  carbonCreditsProduced: number;
  weeklyPayment: number;
  rewards: {
    glow: number;
    usdg: number;
  };
}

export interface DeviceLifetimeMetrics {
  hexlifiedPublicKey: string;
  shortId: number;
  totalCarbonCreditsProduced: number;
  totalRewards: {
    glow: number;
    usdg: number;
  };
  weeklyData: DeviceWeeklyData[];
}

interface ApiRes {
  res: {
    success: boolean;
    data: DeviceLifetimeMetrics[];
  };
}

// Accepts weekNumber as param
export async function getDevicesLifetimeMetrics(): Promise<
  DeviceLifetimeMetrics[]
> {
  const url = `https://glow-green-api.simonnfts.workers.dev/devices-lifetime-metrics`;
  const get = await fetch(url, {
    method: "GET",
  });
  if (!get.ok) throw new Error(get.statusText);
  const resJson = (await get.json()) as ApiRes;
  if (!resJson.res.success) throw new Error("Failed to fetch farms");
  return resJson.res.data;
}
