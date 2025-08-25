type PubkeyAndShortId = { pubkey: string; shortId: number };
type ApiReturnType = PubkeyAndShortId[];

export const getPubkeysAndShortIds = async (
  gcaServerUrl: string
): Promise<ApiReturnType> => {
  const body = {
    urls: [gcaServerUrl], //ex : http://95.217.194.59:35015
  };
  const url = `https://fun-rust-production.up.railway.app/get_pubkeys_and_short_ids`;

  const post = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (post.ok) {
    const resSon = (await post.json()) as ApiReturnType;
    return resSon;
  } else {
    throw new Error("Failed to fetch pubkeys and short ids");
  }
};

type FarmStatus = {
  comments: string[];
  glow_weight: number;
  payment_tx_hash: string;
  protocol_fee_paid_week: number;
  reward_splits: {
    glowSplitPercent: number;
    usdgSplitPercent: number;
    walletAddress: string;
  }[];
  short_id: number;
  status: {
    AuditInherited: {
      oldFarmId: number;
      originalAuditCompleteWeek: number;
      slotRangeActiveInWeekInherited: [number, number];
      weekAuditWasInherited: number;
    };
  };
  timestamp_audited_completed: number;
  weeks_and_slot_ranges_to_invert_power_map: null;
  weeks_and_slots_to_invalidate_power_map: null;
};

export const getFarmsStatus = async (): Promise<{
  crm: FarmStatus[];
  legacy: FarmStatus[];
}> => {
  const url = `https://fun-rust-production.up.railway.app/get_farm_statuses`;
  const post = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (post.ok) {
    const resSon = (await post.json()) as any;
    return resSon;
  } else {
    throw new Error("Failed to fetch farms status");
  }
};
