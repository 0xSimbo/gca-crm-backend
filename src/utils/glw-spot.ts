import Decimal from "decimal.js-light";
import { Hex, PublicClient, createPublicClient, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

const UNIV2_PAIR_ABI = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);

const GLW_ADDRESS = "0xf4fbc617a5733eaaf9af08e1ab816b103388d8b6";
const USDG_ADDRESS = "0xe010ec500720be9ef3f82129e7ed2ee1fb7955f2";
const PAIR_ADDRESS = "0x6fa09ffc45f1ddc95c1bc192956717042f142c5d";

export interface GlwSpotPriceResult {
  price: string;
  glwReserve: string;
  usdgReserve: string;
}

export async function getGlwSpotPrice(
  publicClient: PublicClient
): Promise<GlwSpotPriceResult> {
  const token0Address = (await publicClient.readContract({
    address: PAIR_ADDRESS as Hex,
    abi: UNIV2_PAIR_ABI,
    functionName: "token0",
  })) as string;

  const token1Address = (await publicClient.readContract({
    address: PAIR_ADDRESS as Hex,
    abi: UNIV2_PAIR_ABI,
    functionName: "token1",
  })) as string;

  const reserves = (await publicClient.readContract({
    address: PAIR_ADDRESS as Hex,
    abi: UNIV2_PAIR_ABI,
    functionName: "getReserves",
  })) as readonly [bigint, bigint, number];
  const [reserve0, reserve1] = reserves;

  const [token0Decimals, token1Decimals] = await Promise.all([
    publicClient.readContract({
      address: token0Address as Hex,
      abi: ERC20_ABI,
      functionName: "decimals",
    }) as Promise<number>,
    publicClient.readContract({
      address: token1Address as Hex,
      abi: ERC20_ABI,
      functionName: "decimals",
    }) as Promise<number>,
  ]);

  const t0 = token0Address.toLowerCase();
  const t1 = token1Address.toLowerCase();
  const isT0GLW = t0 === GLW_ADDRESS.toLowerCase();
  const isT1GLW = t1 === GLW_ADDRESS.toLowerCase();
  const isT0USDG = t0 === USDG_ADDRESS.toLowerCase();
  const isT1USDG = t1 === USDG_ADDRESS.toLowerCase();

  if (!(isT0GLW || isT1GLW) || !(isT0USDG || isT1USDG)) {
    throw new Error("Pair does not contain expected GLW/USDG tokens");
  }

  const glwReserveRaw = isT0GLW ? reserve0 : reserve1;
  const usdgReserveRaw = isT0USDG ? reserve0 : reserve1;
  const glwDecimals = isT0GLW ? token0Decimals : token1Decimals;
  const usdgDecimals = isT0USDG ? token0Decimals : token1Decimals;

  const glw = new Decimal(glwReserveRaw.toString()).div(
    new Decimal(10).pow(glwDecimals)
  );
  const usdg = new Decimal(usdgReserveRaw.toString()).div(
    new Decimal(10).pow(usdgDecimals)
  );
  const priceNum = glw.lte(0) ? 0 : Number(usdg.div(glw).toString());
  const price =
    Number.isFinite(priceNum) && priceNum > 0 ? priceNum.toFixed(6) : "0";

  return {
    price,
    glwReserve: glw.toString(),
    usdgReserve: usdg.toString(),
  };
}

// Simple in-process cache for GLW price and viem public client
let cachedPublicClient: PublicClient | null = null;
let cachedPriceNumber: number = 0;
let cachedPriceExpiryMs = 0;

function getOrCreatePublicClient(): PublicClient | null {
  if (cachedPublicClient) return cachedPublicClient;
  if (!process.env.MAINNET_RPC_URL) return null;
  cachedPublicClient = createPublicClient({
    chain: mainnet,
    transport: http(process.env.MAINNET_RPC_URL),
  });
  return cachedPublicClient;
}

export async function getCachedGlwSpotPriceNumber(
  ttlMs = 30_000
): Promise<number> {
  const now = Date.now();
  if (now < cachedPriceExpiryMs && cachedPriceNumber > 0)
    return cachedPriceNumber;

  const client = getOrCreatePublicClient();
  if (!client) return 0;

  try {
    const spot = await getGlwSpotPrice(client);
    const price = parseFloat(spot.price);
    if (Number.isFinite(price) && price > 0) {
      cachedPriceNumber = price;
      cachedPriceExpiryMs = now + ttlMs;
      return cachedPriceNumber;
    }
  } catch {
    // swallow
  }
  return 0;
}
