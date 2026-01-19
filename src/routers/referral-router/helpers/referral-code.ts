import { db } from "../../../db/db";
import { referralCodes } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { viemClient } from "../../../lib/web3-providers/viem-client";
import { customAlphabet } from "nanoid";
import { isValidReferralCode } from "./referral-validation";

const nanoid = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 8);
const MAX_REFERRAL_CODE_LENGTH = 32;

export async function getOrCreateReferralCode(walletAddress: string) {
  const normalizedWallet = walletAddress.toLowerCase();

  // 1. Check if already exists
  const existing = await db.query.referralCodes.findFirst({
    where: eq(referralCodes.walletAddress, normalizedWallet),
  });

  if (existing) {
    return existing;
  }

  // 2. Generate new code
  // Try ENS first (optional, but nice)
  let code = "";
  try {
    const ensName = await viemClient.getEnsName({
      address: normalizedWallet as `0x${string}`,
    });
    if (
      ensName &&
      !ensName.includes("[") &&
      ensName.length <= MAX_REFERRAL_CODE_LENGTH &&
      isValidReferralCode(ensName)
    ) {
      code = ensName;
    }
  } catch (e) {
    // console.warn("ENS lookup failed for referral code generation", e);
  }

  if (!code) {
    code = nanoid();
  }

  // Ensure uniqueness (simple retry if collision)
  let finalCode = code;
  let attempts = 0;
  while (attempts < 5) {
    const collision = await db.query.referralCodes.findFirst({
      where: eq(referralCodes.code, finalCode),
    });
    if (!collision) break;
    if (code.length <= MAX_REFERRAL_CODE_LENGTH - 5) {
      finalCode = `${code}-${nanoid(4)}`;
    } else {
      finalCode = nanoid();
      code = finalCode;
    }
    attempts++;
  }

  const shareableLink = `https://app.glow.org/r/${finalCode}`;

  const [record] = await db
    .insert(referralCodes)
    .values({
      walletAddress: normalizedWallet,
      code: finalCode,
      shareableLink,
    })
    .returning();

  return record;
}
