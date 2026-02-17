import { createPublicClient, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";

import { viemClient } from "../../../lib/web3-providers/viem-client";
import { addresses } from "../../../constants/addresses";

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);
const RETRYABLE_RPC_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const FALLBACK_RPC_TIMEOUT_MS = 15_000;
const FALLBACK_RPC_RETRY_COUNT = 2;
const FALLBACK_RPC_RETRY_DELAY_MS = 200;

type ReadContractClient = Pick<typeof viemClient, "readContract">;

let cachedFallbackViemClient: ReadContractClient | null = null;

function getGlowTokenAddress(): `0x${string}` {
  const fromEnv = process.env.GLOW_TOKEN_ADDRESS;
  if (fromEnv && /^0x[a-fA-F0-9]{40}$/.test(fromEnv)) {
    return fromEnv as `0x${string}`;
  }
  return addresses.glow;
}

function getFallbackMainnetRpcUrl(): string {
  const fromEnv = process.env.MAINNET_RPC_FALLBACK_URL?.trim();
  if (fromEnv && /^https?:\/\//i.test(fromEnv)) return fromEnv;

  const chainDefaultRpcUrl = mainnet.rpcUrls.default.http[0];
  if (!chainDefaultRpcUrl) {
    throw new Error("No fallback RPC URL available for Ethereum mainnet");
  }
  return chainDefaultRpcUrl;
}

function getFallbackViemClient(): ReadContractClient {
  if (cachedFallbackViemClient) return cachedFallbackViemClient;

  cachedFallbackViemClient = createPublicClient({
    chain: mainnet,
    transport: http(getFallbackMainnetRpcUrl(), {
      timeout: FALLBACK_RPC_TIMEOUT_MS,
      retryCount: FALLBACK_RPC_RETRY_COUNT,
      retryDelay: FALLBACK_RPC_RETRY_DELAY_MS,
    }),
  });

  return cachedFallbackViemClient;
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error == null) return null;

  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) return status;

  const causeStatus = (error as { cause?: { status?: unknown } }).cause?.status;
  if (typeof causeStatus === "number" && Number.isFinite(causeStatus))
    return causeStatus;

  return null;
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRetryableRpcTransportError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (status != null) return RETRYABLE_RPC_STATUS_CODES.has(status);

  const message = getErrorText(error).toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("socket hang up") ||
    message.includes("connection reset")
  );
}

async function readGlwBalanceWei({
  client,
  glw,
  walletAddress,
}: {
  client: ReadContractClient;
  glw: `0x${string}`;
  walletAddress: `0x${string}`;
}): Promise<bigint> {
  return await client.readContract({
    address: glw,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [walletAddress],
  });
}

export async function getLiquidGlwBalanceWei(
  walletAddress: `0x${string}`
): Promise<bigint> {
  if (process.env.NODE_ENV !== "production") {
    return BigInt(0);
  }

  const glw = getGlowTokenAddress();
  try {
    return await readGlwBalanceWei({
      client: viemClient,
      glw,
      walletAddress,
    });
  } catch (primaryError) {
    if (!isRetryableRpcTransportError(primaryError)) throw primaryError;

    try {
      return await readGlwBalanceWei({
        client: getFallbackViemClient(),
        glw,
        walletAddress,
      });
    } catch (fallbackError) {
      throw new Error(
        `Failed to fetch GLW balance from primary and fallback RPC providers. primary=${getErrorText(
          primaryError
        )}; fallback=${getErrorText(fallbackError)}`
      );
    }
  }
}
