#!/usr/bin/env bun
import { and, eq } from "drizzle-orm";

import { db } from "../src/db/db";
import { applications, farms } from "../src/db/schema";

const DEFAULT_FARM_ID = "70726b4f-ee2c-4105-9f5c-7e065f33fc3b";
const DEFAULT_APPLICATION_ID = "3c8a504d-64e1-4dca-b747-34fd438fa339";
const DEFAULT_EXPECTED_CURRENT_USD6 = 28_072_930_000n; // $28,072.93
const DEFAULT_NEW_USD6 = 43_547_840_000n; // $43,547.84
const DEFAULT_NEW_REVISED_ESTIMATED_PROTOCOL_FEES = "43547.84";
const DEFAULT_EXPECTED_PAYMENT_CURRENCY = "GLW";
const DEFAULT_EXPECTED_PAYMENT_AMOUNT = "94349247244700765939670";

interface ScriptArgs {
  farmId: string;
  applicationId: string;
  expectedCurrentUsd6: bigint;
  newUsd6: bigint;
  expectedPaymentCurrency: string;
  expectedPaymentAmount: string;
  newRevisedEstimatedProtocolFees: string | null;
  dryRun: boolean;
  allowCurrentMismatch: boolean;
}

function parseBigIntArg(raw: string, flag: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`Invalid bigint for ${flag}: ${raw}`);
  }
}

function parseArgs(argv: string[]): ScriptArgs {
  const getValue = (flag: string): string | undefined => {
    const i = argv.findIndex((arg) => arg === flag);
    if (i === -1) return undefined;
    return argv[i + 1];
  };

  const execute = argv.includes("--execute");
  const dryRunFlag = argv.includes("--dry-run");
  const dryRun = dryRunFlag || !execute;

  if (execute && dryRunFlag) {
    throw new Error("Use either --execute or --dry-run (not both)");
  }

  const farmId = getValue("--farm-id") ?? DEFAULT_FARM_ID;
  const applicationId =
    getValue("--application-id") ?? DEFAULT_APPLICATION_ID;
  const expectedCurrentUsd6 = parseBigIntArg(
    getValue("--expected-current-usd6") ??
      DEFAULT_EXPECTED_CURRENT_USD6.toString(),
    "--expected-current-usd6"
  );
  const newUsd6 = parseBigIntArg(
    getValue("--new-usd6") ?? DEFAULT_NEW_USD6.toString(),
    "--new-usd6"
  );
  const expectedPaymentCurrency =
    getValue("--expected-payment-currency") ??
    DEFAULT_EXPECTED_PAYMENT_CURRENCY;
  const expectedPaymentAmount =
    getValue("--expected-payment-amount") ?? DEFAULT_EXPECTED_PAYMENT_AMOUNT;

  const skipRevised = argv.includes("--skip-revised-estimated-protocol-fees");
  const newRevisedEstimatedProtocolFees = skipRevised
    ? null
    : getValue("--new-revised-estimated-protocol-fees") ??
      DEFAULT_NEW_REVISED_ESTIMATED_PROTOCOL_FEES;

  if (!farmId.trim()) throw new Error("--farm-id cannot be empty");
  if (!applicationId.trim()) throw new Error("--application-id cannot be empty");
  if (expectedCurrentUsd6 <= 0n) {
    throw new Error("--expected-current-usd6 must be > 0");
  }
  if (newUsd6 <= 0n) throw new Error("--new-usd6 must be > 0");
  if (!expectedPaymentCurrency.trim()) {
    throw new Error("--expected-payment-currency cannot be empty");
  }
  if (!expectedPaymentAmount.trim()) {
    throw new Error("--expected-payment-amount cannot be empty");
  }

  return {
    farmId,
    applicationId,
    expectedCurrentUsd6,
    newUsd6,
    expectedPaymentCurrency,
    expectedPaymentAmount,
    newRevisedEstimatedProtocolFees,
    dryRun,
    allowCurrentMismatch: argv.includes("--allow-current-mismatch"),
  };
}

function formatUsd6(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const integer = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${sign}${integer}.${fraction}`;
}

function computeImpliedGlwPriceUsd6(
  protocolDepositUsd6: bigint,
  glwAmount18Decimals: bigint
): bigint | null {
  if (glwAmount18Decimals <= 0n) return null;
  return (protocolDepositUsd6 * 10n ** 18n) / glwAmount18Decimals;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log("=".repeat(88));
  console.log("PATCH OKLAHOMA FARM PROTOCOL FEE (HUB)");
  console.log("=".repeat(88));
  console.log(`Farm ID:                         ${args.farmId}`);
  console.log(`Application ID:                  ${args.applicationId}`);
  console.log(`Expected current USD6:           ${args.expectedCurrentUsd6}`);
  console.log(`Target USD6:                     ${args.newUsd6}`);
  console.log(`Expected payment currency:       ${args.expectedPaymentCurrency}`);
  console.log(`Expected payment amount:         ${args.expectedPaymentAmount}`);
  console.log(
    `Revised estimated protocol fee:    ${
      args.newRevisedEstimatedProtocolFees ?? "SKIPPED"
    }`
  );
  console.log(`Mode:                            ${args.dryRun ? "DRY RUN" : "EXECUTE"}`);
  console.log(
    `Allow current mismatch:          ${args.allowCurrentMismatch ? "YES" : "NO"}`
  );
  console.log();

  const [app] = await db
    .select({
      id: applications.id,
      farmId: applications.farmId,
      finalProtocolFee: applications.finalProtocolFee,
      revisedEstimatedProtocolFees: applications.revisedEstimatedProtocolFees,
      paymentCurrency: applications.paymentCurrency,
      paymentAmount: applications.paymentAmount,
    })
    .from(applications)
    .where(eq(applications.id, args.applicationId))
    .limit(1);

  if (!app) {
    throw new Error(`Application not found: ${args.applicationId}`);
  }

  if (app.farmId !== args.farmId) {
    throw new Error(
      `Application ${args.applicationId} points to farm ${app.farmId ?? "NULL"}, expected ${args.farmId}`
    );
  }

  const [farm] = await db
    .select({
      id: farms.id,
      protocolFee: farms.protocolFee,
      name: farms.name,
      region: farms.region,
    })
    .from(farms)
    .where(eq(farms.id, args.farmId))
    .limit(1);

  if (!farm) {
    throw new Error(`Farm not found: ${args.farmId}`);
  }

  const currentAppUsd6 = app.finalProtocolFee;
  const currentFarmUsd6 = farm.protocolFee;
  const paymentAmountRaw = app.paymentAmount?.toString() ?? "0";
  const paymentAmount18 = BigInt(paymentAmountRaw);
  const paymentCurrency = app.paymentCurrency;

  console.log(`Farm name:                        ${farm.name}`);
  console.log(`Farm region:                      ${farm.region}`);
  console.log(`Current app.finalProtocolFee:     ${currentAppUsd6}`);
  console.log(`Current farms.protocolFee:        ${currentFarmUsd6}`);
  console.log(`Current paymentCurrency:          ${paymentCurrency}`);
  console.log(`Current paymentAmount:            ${paymentAmountRaw}`);
  console.log(
    `Current revisedEstimatedFees:     ${app.revisedEstimatedProtocolFees ?? "NULL"}`
  );

  const currentImpliedGlwPriceUsd6 = computeImpliedGlwPriceUsd6(
    currentAppUsd6,
    paymentAmount18
  );
  const newImpliedGlwPriceUsd6 = computeImpliedGlwPriceUsd6(
    args.newUsd6,
    paymentAmount18
  );

  if (paymentCurrency.toUpperCase() === "GLW") {
    if (currentImpliedGlwPriceUsd6 !== null) {
      console.log(
        `Implied GLW price (current):      $${formatUsd6(currentImpliedGlwPriceUsd6)}`
      );
    }
    if (newImpliedGlwPriceUsd6 !== null) {
      console.log(
        `Implied GLW price (new):          $${formatUsd6(newImpliedGlwPriceUsd6)}`
      );
    }
  }

  console.log();

  const mismatches: string[] = [];
  if (!args.allowCurrentMismatch) {
    if (
      currentAppUsd6 !== args.newUsd6 &&
      currentAppUsd6 !== args.expectedCurrentUsd6
    ) {
      mismatches.push(
        `applications.finalProtocolFee=${currentAppUsd6} (expected ${args.expectedCurrentUsd6} or already-patched ${args.newUsd6})`
      );
    }
    if (
      currentFarmUsd6 !== args.newUsd6 &&
      currentFarmUsd6 !== args.expectedCurrentUsd6
    ) {
      mismatches.push(
        `farms.protocolFee=${currentFarmUsd6} (expected ${args.expectedCurrentUsd6} or already-patched ${args.newUsd6})`
      );
    }
    if (
      paymentCurrency.toUpperCase() !==
      args.expectedPaymentCurrency.toUpperCase()
    ) {
      mismatches.push(
        `applications.paymentCurrency=${paymentCurrency} (expected ${args.expectedPaymentCurrency})`
      );
    }
    if (paymentAmountRaw !== args.expectedPaymentAmount) {
      mismatches.push(
        `applications.paymentAmount=${paymentAmountRaw} (expected ${args.expectedPaymentAmount})`
      );
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Guard checks failed:\n- ${mismatches.join("\n- ")}\nUse --allow-current-mismatch if this is intentional.`
    );
  }

  if (currentAppUsd6 === args.newUsd6 && currentFarmUsd6 === args.newUsd6) {
    console.log("No update needed: target USD6 already applied in both applications and farms.");
    return;
  }

  console.log("Planned updates:");
  console.log(
    `- applications.finalProtocolFee:    ${currentAppUsd6} -> ${args.newUsd6}`
  );
  console.log(`- farms.protocolFee:               ${currentFarmUsd6} -> ${args.newUsd6}`);
  if (args.newRevisedEstimatedProtocolFees !== null) {
    console.log(
      `- applications.revisedEstimatedProtocolFees: ${app.revisedEstimatedProtocolFees ?? "NULL"} -> ${args.newRevisedEstimatedProtocolFees}`
    );
  } else {
    console.log("- applications.revisedEstimatedProtocolFees: SKIPPED");
  }
  console.log("- applications.paymentAmount:      unchanged");
  console.log("- applications.paymentCurrency:    unchanged");
  console.log();

  if (args.dryRun) {
    console.log("DRY RUN: no database changes were applied.");
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(applications)
      .set({
        finalProtocolFee: args.newUsd6,
        ...(args.newRevisedEstimatedProtocolFees !== null
          ? {
              revisedEstimatedProtocolFees:
                args.newRevisedEstimatedProtocolFees,
            }
          : {}),
      })
      .where(
        and(eq(applications.id, args.applicationId), eq(applications.farmId, args.farmId))
      );

    await tx
      .update(farms)
      .set({
        protocolFee: args.newUsd6,
      })
      .where(eq(farms.id, args.farmId));
  });

  const [updated] = await db
    .select({
      appFinalProtocolFee: applications.finalProtocolFee,
      appRevisedEstimatedProtocolFees: applications.revisedEstimatedProtocolFees,
      farmProtocolFee: farms.protocolFee,
    })
    .from(applications)
    .innerJoin(farms, eq(applications.farmId, farms.id))
    .where(eq(applications.id, args.applicationId))
    .limit(1);

  if (!updated) {
    throw new Error("Post-update verification failed: record not found");
  }

  console.log("Update applied successfully.");
  console.log(`applications.finalProtocolFee=${updated.appFinalProtocolFee}`);
  console.log(`farms.protocolFee=${updated.farmProtocolFee}`);
  console.log(
    `applications.revisedEstimatedProtocolFees=${updated.appRevisedEstimatedProtocolFees ?? "NULL"}`
  );
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("Script failed:", error);
    process.exit(1);
  });
