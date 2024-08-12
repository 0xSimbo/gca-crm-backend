// https://fun-rust-production.up.railway.app/get_pubkeys_and_short_ids

export async function getAllHexkeysAndShortIds() {
  const baseUrl = "https://fun-rust-production.up.railway.app";
  const endpoint = "/get_pubkeys_and_short_ids";
  const url = `${baseUrl}${endpoint}`;
  const body = {
    urls: ["http://95.217.194.59:35015"],
  };
  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
    },
  });
  const data = (await response.json()) as {
    pubkey: `0x${string}`;
    shortId: number;
  }[];
  return data;
}
