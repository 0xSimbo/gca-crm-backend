import { t } from "elysia";
import { checksumAddress, type Hex } from "viem";
import { viemClient } from "../lib/web3-providers/viem-client";

// ============================================
// EIP-712 Domain
// ============================================

export const referralEIP712Domain = (chainId: number) => ({
  name: "GlowReferral",
  version: "1",
  chainId,
  verifyingContract: "0x0000000000000000000000000000000000000000" as const,
});

// ============================================
// EIP-712 Types
// ============================================

export const linkReferralEIP712Types = {
  LinkReferral: [
    { name: "nonce", type: "uint256" },
    { name: "referralCode", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const changeReferrerEIP712Types = {
  ChangeReferrer: [
    { name: "nonce", type: "uint256" },
    { name: "newReferralCode", type: "string" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// ============================================
// Request Schemas (Elysia validation)
// ============================================

export const linkReferralSignatureRequestSchema = t.Object({
  wallet: t.String({ format: "regex", pattern: "^0x[a-fA-F0-9]{40}$" }),
  signature: t.String({ format: "regex", pattern: "^0x[a-fA-F0-9]{130}$" }),
  nonce: t.String(),
  referralCode: t.String(),
  deadline: t.String(),
});

export const changeReferrerSignatureRequestSchema = t.Object({
  wallet: t.String({ format: "regex", pattern: "^0x[a-fA-F0-9]{40}$" }),
  signature: t.String({ format: "regex", pattern: "^0x[a-fA-F0-9]{130}$" }),
  nonce: t.String(),
  newReferralCode: t.String(),
  deadline: t.String(),
});

export type LinkReferralSignatureRequest =
  typeof linkReferralSignatureRequestSchema.static;
export type ChangeReferrerSignatureRequest =
  typeof changeReferrerSignatureRequestSchema.static;

// ============================================
// Message Types
// ============================================

export type LinkReferralMessage = {
  nonce: bigint;
  referralCode: string;
  deadline: bigint;
};

export type ChangeReferrerMessage = {
  nonce: bigint;
  newReferralCode: string;
  deadline: bigint;
};

// ============================================
// Message Builders
// ============================================

export function buildLinkReferralMessage(
  req: Pick<LinkReferralSignatureRequest, "nonce" | "referralCode" | "deadline">
): LinkReferralMessage {
  const nonce = BigInt(req.nonce);
  const deadline = BigInt(req.deadline);
  if (nonce < 0n) throw new Error("Nonce must be non-negative");
  if (deadline < 0n) throw new Error("Deadline must be non-negative");
  if (!req.referralCode) throw new Error("referralCode must be non-empty");
  return { nonce, referralCode: req.referralCode, deadline };
}

export function buildChangeReferrerMessage(
  req: Pick<
    ChangeReferrerSignatureRequest,
    "nonce" | "newReferralCode" | "deadline"
  >
): ChangeReferrerMessage {
  const nonce = BigInt(req.nonce);
  const deadline = BigInt(req.deadline);
  if (nonce < 0n) throw new Error("Nonce must be non-negative");
  if (deadline < 0n) throw new Error("Deadline must be non-negative");
  if (!req.newReferralCode)
    throw new Error("newReferralCode must be non-empty");
  return { nonce, newReferralCode: req.newReferralCode, deadline };
}

// ============================================
// Signature Validation
// ============================================

export type SignatureValidationResult = {
  valid: boolean;
  recovered: string | null;
  reason: "deadline_expired" | "signature_failed" | "signer_mismatch" | null;
};

function isDeadlineExpired(deadline: bigint): boolean {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  return deadline < nowSeconds;
}

/**
 * Verifies an EIP-712 typed data signature for both EOA and smart contract wallets.
 * Uses viem's publicClient.verifyTypedData which automatically handles:
 * - EOA wallets (standard ECDSA signature verification)
 * - Smart contract wallets (ERC-1271 signature validation)
 * - Undeployed contracts (EIP-6492 validation)
 */
async function verifyEIP712Signature(params: {
  address: Hex;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: `0x${string}`;
  };
  types: any;
  primaryType: string;
  message: any;
  signature: Hex;
}): Promise<boolean> {
  const { address, domain, types, primaryType, message, signature } = params;

  try {
    // Ensure domain.chainId matches the client chain; mismatch will fail verification
    if (domain.chainId !== viemClient.chain.id) {
      console.warn(
        `Domain chainId ${domain.chainId} does not match client chain ${viemClient.chain.id}. Verification might fail if using mainnet client for testnet domain.`
      );
    }

    // This handles EOA, ERC-1271, and EIP-6492 automatically
    return await viemClient.verifyTypedData({
      address,
      domain,
      types,
      primaryType,
      message,
      signature,
    } as any);
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

export async function validateLinkReferralSignature(
  input: LinkReferralSignatureRequest,
  domain = referralEIP712Domain(Number(process.env.CHAIN_ID) || 1)
): Promise<SignatureValidationResult> {
  const message = buildLinkReferralMessage({
    nonce: input.nonce,
    referralCode: input.referralCode,
    deadline: input.deadline,
  });
  if (isDeadlineExpired(message.deadline)) {
    return { valid: false, recovered: null, reason: "deadline_expired" };
  }
  try {
    const verified = await verifyEIP712Signature({
      address: checksumAddress(input.wallet as Hex),
      domain,
      types: linkReferralEIP712Types,
      primaryType: "LinkReferral",
      message,
      signature: input.signature as Hex,
    });
    return verified
      ? { valid: true, recovered: input.wallet, reason: null }
      : { valid: false, recovered: null, reason: "signer_mismatch" };
  } catch (_) {
    return { valid: false, recovered: null, reason: "signature_failed" };
  }
}

export async function validateChangeReferrerSignature(
  input: ChangeReferrerSignatureRequest,
  domain = referralEIP712Domain(Number(process.env.CHAIN_ID) || 1)
): Promise<SignatureValidationResult> {
  const message = buildChangeReferrerMessage({
    nonce: input.nonce,
    newReferralCode: input.newReferralCode,
    deadline: input.deadline,
  });
  if (isDeadlineExpired(message.deadline)) {
    return { valid: false, recovered: null, reason: "deadline_expired" };
  }
  try {
    const verified = await verifyEIP712Signature({
      address: checksumAddress(input.wallet as Hex),
      domain,
      types: changeReferrerEIP712Types,
      primaryType: "ChangeReferrer",
      message,
      signature: input.signature as Hex,
    });
    return verified
      ? { valid: true, recovered: input.wallet, reason: null }
      : { valid: false, recovered: null, reason: "signer_mismatch" };
  } catch (_) {
    return { valid: false, recovered: null, reason: "signature_failed" };
  }
}
