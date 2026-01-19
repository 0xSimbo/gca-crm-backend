import { db } from "../../../db/db";
import { referrals } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { validateReferralLink, canClaimReferrer, getReferralNonce, incrementReferralNonce } from "./referral-validation";

export async function linkReferrer(params: {
  refereeWallet: string;
  referralCode: string;
  referrerWallet: string;
  nonce: string;
  requireExisting?: boolean;
}) {
  const { refereeWallet, referralCode, referrerWallet, nonce, requireExisting } =
    params;
  const normalizedReferee = refereeWallet.toLowerCase();
  const normalizedReferrer = referrerWallet.toLowerCase();

  // 1. Nonce check
  const currentNonce = await getReferralNonce(normalizedReferee);
  if (BigInt(nonce) !== BigInt(currentNonce)) {
    throw new Error(`Invalid nonce. Expected ${currentNonce}, got ${nonce}`);
  }

  // 2. Validation
  const validation = await validateReferralLink({
    referrerWallet: normalizedReferrer,
    refereeWallet: normalizedReferee,
    referralCode,
  });

  if (!validation.valid) {
    throw new Error(validation.error || "Invalid referral link request");
  }

  // 3. Check if can claim (grace period or migration)
  const claimCheck = await canClaimReferrer(normalizedReferee);
  if (!claimCheck.canClaim) {
    throw new Error(claimCheck.reason || "Referrer cannot be linked");
  }

  // 4. Create or update referral
  const now = new Date();
  const gracePeriodEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const refereeBonusEndsAt = new Date(now.getTime() + 12 * 7 * 24 * 60 * 60 * 1000);

  const existing = await db.query.referrals.findFirst({
    where: eq(referrals.refereeWallet, normalizedReferee),
  });

  let result;
  if (existing) {
    // Within grace period, updating (preserve original link timing + bonus window)
    const [updated] = await db
      .update(referrals)
      .set({
        referrerWallet: normalizedReferrer,
        previousReferrerWallet: existing.referrerWallet,
        referralCode,
        referrerChangedAt: now,
        updatedAt: now,
      })
      .where(eq(referrals.id, existing.id))
      .returning();
    result = updated;
  } else {
    if (requireExisting) {
      throw new Error("No existing referral");
    }
    // New referral
    const [created] = await db
      .insert(referrals)
      .values({
        refereeWallet: normalizedReferee,
        referrerWallet: normalizedReferrer,
        referralCode,
        linkedAt: now,
        gracePeriodEndsAt,
        refereeBonusEndsAt,
        status: "pending",
      })
      .returning();
    result = created;
  }

  // 5. Increment nonce
  await incrementReferralNonce(normalizedReferee);

  return result;
}
