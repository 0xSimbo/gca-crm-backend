// pub struct GetHexKeyFromShortIdBody {
//     pub gca_url: String, //TODO: When GCA's get clusters , we will need to fix this.
//     pub short_ids: Vec<u64>,
// }
export async function getHexPubkeyFromShortId(shortId: string) {
  const baseUrl = "https://fun-rust-production.up.railway.app";
  const gcaUrl = "http://95.217.194.59:35015";
  const endpoint = "/get_hexkeys_from_short_ids";

  const url = `${baseUrl}${endpoint}`;
  const body = {
    gca_url: gcaUrl,
    short_ids: [Number(shortId)],
  };

  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
    },
  });

  const data = (await response.json()) as {
    hexkey: string;
    short_id: number;
  }[];
  const hexPubkey = data[0].hexkey;
  if (!hexPubkey) {
    console.log("No hexkey found for shortId", shortId);
    throw new Error("No hexkey found for shortId");
  }
  return hexPubkey;
}
