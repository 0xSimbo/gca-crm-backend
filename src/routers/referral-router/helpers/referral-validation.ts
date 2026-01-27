import { db } from "../../../db/db";
import {
  referrals,
  referralCodes,
  referralNonces,
  users,
} from "../../../db/schema";
import { eq, and, gt, sql } from "drizzle-orm";

export async function getReferralByReferee(refereeWallet: string) {
  return await db.query.referrals.findFirst({
    where: eq(referrals.refereeWallet, refereeWallet.toLowerCase()),
  });
}

export async function getReferralCodeRecord(code: string) {
  return await db.query.referralCodes.findFirst({
    where: eq(referralCodes.code, code),
  });
}

export async function getReferralNonce(walletAddress: string): Promise<number> {
  const record = await db.query.referralNonces.findFirst({
    where: eq(referralNonces.walletAddress, walletAddress.toLowerCase()),
  });
  return record?.nonce ?? 0;
}

export async function incrementReferralNonce(walletAddress: string) {
  const normalizedWallet = walletAddress.toLowerCase();
  await db
    .insert(referralNonces)
    .values({ walletAddress: normalizedWallet, nonce: 1 })
    .onConflictDoUpdate({
      target: referralNonces.walletAddress,
      set: { nonce: sql`${referralNonces.nonce} + 1`, updatedAt: new Date() },
    });
}

const PROD_REFERRAL_FEATURE_LAUNCH_DATE = new Date("2026-01-27T15:00:00Z");
const STAGING_REFERRAL_FEATURE_LAUNCH_DATE = new Date("2026-01-12T00:00:00Z");
const EXISTING_USER_GRACE_PERIOD_DAYS = 14;

function getReferralFeatureLaunchDate(): Date {
  const raw = process.env.REFERRAL_FEATURE_LAUNCH_DATE?.trim();
  if (!raw) {
    return process.env.NODE_ENV === "production"
      ? PROD_REFERRAL_FEATURE_LAUNCH_DATE
      : STAGING_REFERRAL_FEATURE_LAUNCH_DATE;
  }
  if (raw.toLowerCase() === "now") {
    return new Date();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return process.env.NODE_ENV === "production"
      ? PROD_REFERRAL_FEATURE_LAUNCH_DATE
      : STAGING_REFERRAL_FEATURE_LAUNCH_DATE;
  }
  return parsed;
}

export async function canClaimReferrer(wallet: string): Promise<{
  canClaim: boolean;
  reason?: string;
  gracePeriodEndsAt?: Date;
}> {
  const normalizedWallet = wallet.toLowerCase();

  // 1. Check if already has a permanent referral
  const existing = await getReferralByReferee(normalizedWallet);
  if (existing) {
    if (existing.status === "active") {
      return { canClaim: false, reason: "Referrer is already active" };
    }
    const now = new Date();
    if (now < existing.gracePeriodEndsAt) {
      return { canClaim: true, gracePeriodEndsAt: existing.gracePeriodEndsAt };
    }
    return { canClaim: false, reason: "Referrer is already permanent" };
  }

  // 2. Check if new user or in migration window
  // Use case-insensitive match for user ID
  const userRecord = await db.query.users.findFirst({
    where: (u, { eq, sql }) => eq(sql`lower(${u.id})`, normalizedWallet),
  });

  const referralLaunchDate = getReferralFeatureLaunchDate();
  if (!userRecord || userRecord.createdAt > referralLaunchDate) {
    return { canClaim: true, reason: "New user" };
  }

  const migrationDeadline = new Date(referralLaunchDate);
  migrationDeadline.setDate(
    migrationDeadline.getDate() + EXISTING_USER_GRACE_PERIOD_DAYS
  );

  const now = new Date();
  if (now < migrationDeadline) {
    return {
      canClaim: true,
      gracePeriodEndsAt: migrationDeadline,
      reason: "Migration window",
    };
  }

  return { canClaim: false, reason: "Migration claim window has expired" };
}

export async function validateReferralLink(params: {
  referrerWallet: string;
  refereeWallet: string;
  referralCode: string;
}) {
  const { referrerWallet, refereeWallet, referralCode } = params;

  if (!isValidReferralCode(referralCode)) {
    return { valid: false, error: "Invalid referral code format" };
  }

  // Rule 1: No self-referral
  if (referrerWallet.toLowerCase() === refereeWallet.toLowerCase()) {
    return { valid: false, error: "Self-referral not allowed" };
  }

  // Rule 2: Code exists and belongs to referrer
  const codeRecord = await getReferralCodeRecord(referralCode);
  if (
    !codeRecord ||
    codeRecord.walletAddress.toLowerCase() !== referrerWallet.toLowerCase()
  ) {
    return { valid: false, error: "Invalid referral code" };
  }

  return { valid: true };
}

export async function canChangeReferrer(refereeWallet: string): Promise<{
  canChange: boolean;
  reason?: string;
  gracePeriodEndsAt?: Date;
}> {
  const result = await canClaimReferrer(refereeWallet);
  return {
    canChange: result.canClaim,
    reason: result.reason,
    gracePeriodEndsAt: result.gracePeriodEndsAt,
  };
}

export function isValidReferralCode(code: string): boolean {
  // alphanumeric, 3-32 chars, dots + hyphens allowed for ENS
  return /^[a-zA-Z0-9.-]{3,32}$/.test(code);
}
