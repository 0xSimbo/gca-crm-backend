/**
 * Script to check and retry failed SGCTL finalize/refund operations
 *
 * Usage:
 *   bun run scripts/check-sgctl-operations.ts [--retry] [--id=<operation_id>]
 *
 * Options:
 *   --retry         Automatically retry all pending SGCTL operations
 *   --id=<id>       Retry a specific operation by ID
 *   (no args)       Just list pending SGCTL operations
 */

import { db } from "../src/db/db";
import { failedFractionOperations, fractions } from "../src/db/schema";
import { eq, inArray, and } from "drizzle-orm";
import {
  manualRetryFailedOperation,
  retryFailedOperations,
} from "../src/services/retryFailedOperations";

async function listSgctlOperations() {
  console.log("\n📋 Checking SGCTL finalize/refund operations...\n");

  const operations = await db
    .select()
    .from(failedFractionOperations)
    .where(
      and(
        inArray(failedFractionOperations.operationType, ["refund", "finalize"]),
        inArray(failedFractionOperations.status, [
          "pending",
          "retrying",
          "failed",
        ])
      )
    )
    .orderBy(failedFractionOperations.createdAt);

  if (operations.length === 0) {
    console.log("✅ No pending/failed SGCTL operations found");
    return [];
  }

  console.log(`Found ${operations.length} SGCTL operations:\n`);

  for (const op of operations) {
    const statusIcon =
      op.status === "failed" ? "❌" : op.status === "retrying" ? "🔄" : "⏳";

    console.log(`${statusIcon} Operation #${op.id}`);
    console.log(`   Type: ${op.operationType}`);
    console.log(`   Fraction: ${op.fractionId || "N/A"}`);
    console.log(`   Status: ${op.status}`);
    console.log(`   Retry Count: ${op.retryCount}/${op.maxRetries}`);
    console.log(`   Created: ${op.createdAt.toISOString()}`);
    console.log(`   Error: ${op.errorMessage}`);

    if (op.eventPayload) {
      const payload = op.eventPayload as any;
      if (payload.farmId) {
        console.log(`   Farm ID: ${payload.farmId}`);
      }
      if (payload.applicationId) {
        console.log(`   Application ID: ${payload.applicationId}`);
      }
    }
    console.log("");
  }

  return operations;
}

async function retrySpecificOperation(operationId: number) {
  console.log(`\n🔄 Manually retrying operation #${operationId}...\n`);

  try {
    const result = await manualRetryFailedOperation(operationId);

    console.log("✅ Retry completed:");
    console.log(`   Operation ID: ${result.operationId}`);
    console.log(`   Type: ${result.operationType}`);
    console.log(`   Fraction: ${result.fractionId || "N/A"}`);
    console.log(`   Status: ${result.status}`);

    if (result.success) {
      console.log("\n✅ Operation resolved successfully!");
    } else {
      console.log(`\n⚠️ Retry failed: ${result.error}`);
    }
  } catch (error) {
    console.error("\n❌ Error during manual retry:", error);
    throw error;
  }
}

async function retryAllPendingOperations() {
  console.log("\n🔄 Retrying all pending SGCTL operations...\n");

  try {
    const result = await retryFailedOperations();

    console.log("✅ Retry process completed:");
    console.log(`   Retried: ${result.retried}`);
    console.log(`   Resolved: ${result.resolved}`);
    console.log(`   Failed: ${result.failed}`);
  } catch (error) {
    console.error("\n❌ Error during retry process:", error);
    throw error;
  }
}

async function checkFractionDetails(fractionId: string) {
  console.log(`\n🔍 Checking fraction ${fractionId}...\n`);

  const [fraction] = await db
    .select()
    .from(fractions)
    .where(eq(fractions.id, fractionId))
    .limit(1);

  if (!fraction) {
    console.log(`❌ Fraction not found: ${fractionId}`);
    return;
  }

  console.log("Fraction details:");
  console.log(`   Type: ${fraction.type}`);
  console.log(`   Status: ${fraction.status}`);
  console.log(`   Is Filled: ${fraction.isFilled}`);
  console.log(`   Splits Sold: ${fraction.splitsSold}/${fraction.totalSteps}`);
  console.log(`   Application ID: ${fraction.applicationId}`);
  console.log(`   Expiration: ${fraction.expirationAt.toISOString()}`);
  console.log(`   Created: ${fraction.createdAt.toISOString()}`);

  if (fraction.filledAt) {
    console.log(`   Filled At: ${fraction.filledAt.toISOString()}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const retryFlag = args.includes("--retry");
  const idArg = args.find((arg) => arg.startsWith("--id="));
  const operationId = idArg ? parseInt(idArg.split("=")[1]) : null;

  try {
    if (operationId) {
      // Retry specific operation
      await retrySpecificOperation(operationId);
    } else if (retryFlag) {
      // Retry all pending operations
      await retryAllPendingOperations();
    } else {
      // Just list operations
      const operations = await listSgctlOperations();

      if (operations.length > 0) {
        console.log("\n💡 To retry all pending operations:");
        console.log("   bun run scripts/check-sgctl-operations.ts --retry");
        console.log("\n💡 To retry a specific operation:");
        console.log(
          "   bun run scripts/check-sgctl-operations.ts --id=<operation_id>"
        );
      }
    }

    // Also check fractions mentioned in failed operations
    const operations = await db
      .select()
      .from(failedFractionOperations)
      .where(
        and(
          inArray(failedFractionOperations.operationType, [
            "refund",
            "finalize",
          ]),
          inArray(failedFractionOperations.status, ["pending", "retrying"])
        )
      )
      .limit(5);

    if (operations.length > 0 && !retryFlag && !operationId) {
      console.log("\n📊 Checking fraction details for pending operations...\n");

      const uniqueFractionIds = [
        ...new Set(
          operations
            .map((op) => op.fractionId)
            .filter((id): id is string => id !== null)
        ),
      ];

      for (const fractionId of uniqueFractionIds) {
        await checkFractionDetails(fractionId);
        console.log("");
      }
    }

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Script failed:", error);
    process.exit(1);
  }
}

main();
