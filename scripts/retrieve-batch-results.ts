import { db } from "../src/db/db";
import { Documents } from "../src/db/schema";
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Step 3: Retrieve batch results and update database
 * Usage: bun run scripts/retrieve-batch-results.ts <batch_id>
 */
async function retrieveBatchResults() {
  try {
    const batchId = process.argv[2];

    if (!batchId) {
      console.error("❌ Please provide a batch ID");
      console.log(
        "Usage: bun run scripts/retrieve-batch-results.ts <batch_id>"
      );
      process.exit(1);
    }

    console.log(`🔍 Retrieving results for batch: ${batchId}\n`);

    // Load batch info
    const batchInfoPath = path.join(
      process.cwd(),
      `batch-info-${batchId}.json`
    );
    if (!fs.existsSync(batchInfoPath)) {
      console.error(`❌ Batch info not found: ${batchInfoPath}`);
      process.exit(1);
    }

    const batchInfo = JSON.parse(fs.readFileSync(batchInfoPath, "utf8"));

    // Check batch status
    const batch = await openai.batches.retrieve(batchId);

    if (batch.status !== "completed") {
      console.log(`⏳ Batch is still ${batch.status}`);
      console.log(`Status details:`);
      console.log(`  Total requests: ${batch.request_counts.total}`);
      console.log(`  Completed: ${batch.request_counts.completed}`);
      console.log(`  Failed: ${batch.request_counts.failed}`);
      process.exit(0);
    }

    if (!batch.output_file_id) {
      console.error("❌ Batch output file not found");
      process.exit(1);
    }

    console.log(`📥 Downloading results...\n`);

    // Retrieve the output file
    const fileResponse = await openai.files.content(batch.output_file_id);
    const fileContent = await fileResponse.text();

    // Parse results
    const results = fileContent
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));

    console.log(`📊 Processing ${results.length} results...\n`);

    // Process results by application
    const resultsByApplication: Record<
      string,
      Array<{
        documentId: string;
        hasSolarPanels: boolean;
        confidence: string;
        response: string;
      }>
    > = {};

    for (const result of results) {
      const imageInfo = batchInfo.imageMap[result.custom_id];
      if (!imageInfo) continue;

      const content =
        result.response?.body?.choices?.[0]?.message?.content?.toLowerCase() ||
        "";
      const hasSolarPanels = content.includes("yes");

      let confidence = "low";
      if (content.includes("high")) confidence = "high";
      else if (content.includes("medium")) confidence = "medium";

      if (!resultsByApplication[imageInfo.applicationId]) {
        resultsByApplication[imageInfo.applicationId] = [];
      }

      resultsByApplication[imageInfo.applicationId].push({
        documentId: imageInfo.documentId,
        hasSolarPanels,
        confidence,
        response: content,
      });
    }

    // Tag top 3 pictures per application
    let totalTagged = 0;
    const confidenceOrder = { high: 3, medium: 2, low: 1 };

    for (const [applicationId, appResults] of Object.entries(
      resultsByApplication
    )) {
      const withSolarPanels = appResults.filter((r) => r.hasSolarPanels);

      if (withSolarPanels.length === 0) {
        console.log(`⚠️  ${applicationId}: No solar panels found`);
        continue;
      }

      // Sort by confidence and take top 3
      const top3 = withSolarPanels
        .sort(
          (a, b) =>
            confidenceOrder[b.confidence as keyof typeof confidenceOrder] -
            confidenceOrder[a.confidence as keyof typeof confidenceOrder]
        )
        .slice(0, 3);

      console.log(
        `✅ ${applicationId}: Found ${withSolarPanels.length} with panels, tagging top ${top3.length}`
      );

      // Update database
      for (const doc of top3) {
        await db
          .update(Documents)
          .set({
            isShowingSolarPanels: true,
            updatedAt: new Date(),
          })
          .where(eq(Documents.id, doc.documentId));

        console.log(`   📌 Tagged document (${doc.confidence} confidence)`);
        totalTagged++;
      }
    }

    // Summary statistics
    const summary = {
      totalApplications: Object.keys(resultsByApplication).length,
      totalImagesAnalyzed: results.length,
      totalTagged: totalTagged,
      applicationsWithPanels: Object.values(resultsByApplication).filter((r) =>
        r.some((doc) => doc.hasSolarPanels)
      ).length,
      applicationsWithoutPanels: Object.values(resultsByApplication).filter(
        (r) => !r.some((doc) => doc.hasSolarPanels)
      ).length,
    };

    console.log(`\n\n📊 Summary:`);
    console.log(`${"=".repeat(50)}`);
    console.log(`Total applications:          ${summary.totalApplications}`);
    console.log(`Total images analyzed:       ${summary.totalImagesAnalyzed}`);
    console.log(
      `Applications with panels:    ${summary.applicationsWithPanels}`
    );
    console.log(
      `Applications without panels: ${summary.applicationsWithoutPanels}`
    );
    console.log(`Total documents tagged:      ${summary.totalTagged}`);

    // Save detailed results
    const resultsPath = path.join(
      process.cwd(),
      `solar-panels-results-${batchId}.json`
    );
    fs.writeFileSync(
      resultsPath,
      JSON.stringify(
        {
          batchId,
          processedAt: new Date().toISOString(),
          summary,
          resultsByApplication,
        },
        null,
        2
      )
    );

    console.log(
      `\n💾 Detailed results saved to solar-panels-results-${batchId}.json`
    );

    // Clean up batch info file
    fs.unlinkSync(batchInfoPath);
    console.log(`🗑️  Cleaned up batch info file`);

    console.log(`\n✅ Batch processing complete!`);
  } catch (error: any) {
    console.error("❌ Error retrieving batch results:", error.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

retrieveBatchResults();
