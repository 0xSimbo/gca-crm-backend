import { keccak256, toUtf8Bytes } from "ethers";
import { getNextWalletNonce } from "../../db/mutations/wallets/walletNonce";

/**
 * Generates a unique fraction ID by combining walletAddress and nonce
 * The ID is created by hashing walletAddress + nonce to create a bytes32 hex string
 *
 * @param walletAddress - The wallet address of the fraction creator
 * @param nonce - The nonce (must be unique for this wallet)
 * @returns bytes32 hex string (0x + 64 characters)
 */
export function createFractionId(walletAddress: string, nonce: number): string {
  const combined = `${walletAddress.toLowerCase()}:${nonce}`;
  return keccak256(toUtf8Bytes(combined));
}

/**
 * Generates a unique fraction ID for a wallet by getting the next available nonce
 *
 * @param walletAddress - The wallet address of the fraction creator
 * @returns Object containing the fraction ID and nonce used
 */
export async function generateUniqueFractionId(walletAddress: string): Promise<{
  fractionId: string;
  nonce: number;
}> {
  const nonce = await getNextWalletNonce(walletAddress);
  const fractionId = createFractionId(walletAddress, nonce);

  return {
    fractionId,
    nonce,
  };
}
