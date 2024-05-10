import { ethers } from "ethers";

// Function to generate a random salt from a public address
export function generateSaltFromAddress(publicAddress: string): string {
  // Generate a random nonce (e.g., 32 bytes)
  const nonce = ethers.utils.hexlify(ethers.utils.randomBytes(32));

  // Combine the nonce with the public address
  const combinedInput = ethers.utils.concat([
    nonce,
    ethers.utils.arrayify(publicAddress),
  ]);

  // Compute the Keccak-256 hash of the combined input
  const salt = ethers.utils.keccak256(combinedInput);

  // Return the salt as a string
  return salt;
}
