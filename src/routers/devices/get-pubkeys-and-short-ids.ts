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
