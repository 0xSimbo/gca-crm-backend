import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Step 2: Check the status of a batch job
 * Usage: bun run scripts/check-batch-status.ts <batch_id>
 */
async function checkBatchStatus() {
  try {
    const batchId = process.argv[2];

    if (!batchId) {
      console.error("❌ Please provide a batch ID");
      console.log("Usage: bun run scripts/check-batch-status.ts <batch_id>");
      process.exit(1);
    }

    console.log(`🔍 Checking status for batch: ${batchId}\n`);

    const batch = await openai.batches.retrieve(batchId);

    console.log(`📊 Batch Status Report`);
    console.log(`${"=".repeat(50)}`);
    console.log(`Batch ID:       ${batch.id}`);
    console.log(`Status:         ${batch.status}`);
    console.log(
      `Created:        ${new Date(batch.created_at * 1000).toISOString()}`
    );

    if (batch.in_progress_at) {
      console.log(
        `Started:        ${new Date(batch.in_progress_at * 1000).toISOString()}`
      );
    }

    if (batch.completed_at) {
      console.log(
        `Completed:      ${new Date(batch.completed_at * 1000).toISOString()}`
      );
      const duration =
        batch.completed_at - (batch.in_progress_at || batch.created_at);
      console.log(`Duration:       ${Math.round(duration / 60)} minutes`);
    }

    if (batch.failed_at) {
      console.log(
        `Failed:         ${new Date(batch.failed_at * 1000).toISOString()}`
      );
    }

    console.log(`\nRequest Counts:`);
    console.log(`  Total:        ${batch.request_counts?.total ?? 0}`);
    console.log(`  Completed:    ${batch.request_counts?.completed ?? 0}`);
    console.log(`  Failed:       ${batch.request_counts?.failed ?? 0}`);

    if (batch.metadata) {
      console.log(`\nMetadata:`);
      Object.entries(batch.metadata).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
      });
    }

    if (batch.status === "completed") {
      console.log(`\n✅ Batch is complete!`);
      console.log(
        `Next step: bun run scripts/retrieve-batch-results.ts ${batchId}`
      );
    } else if (batch.status === "failed") {
      console.log(`\n❌ Batch failed!`);
      if (batch.errors) {
        console.log(`Errors:`, batch.errors);
      }
    } else {
      console.log(`\n⏳ Batch is still processing...`);
      console.log(`Status: ${batch.status}`);
    }
  } catch (error: any) {
    console.error("❌ Error checking batch status:", error.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

checkBatchStatus();
