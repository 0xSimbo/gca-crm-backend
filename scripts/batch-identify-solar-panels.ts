import { db } from "../src/db/db";
import { applications, Documents } from "../src/db/schema";
import { sql, eq, and, like, notInArray } from "drizzle-orm";
import OpenAI from "openai";
import * as fs from "fs";
import * as path from "path";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Step 1: Create batch file and submit to OpenAI
 * This script creates a batch job to identify solar panels in images
 */
async function createBatchJob() {
  try {
    console.log(
      "🔍 Fetching completed applications missing solar panel pictures...\n"
    );

    // Query to find completed applications that don't have any documents with
    // "after_install_pictures" in the name AND isShowingSolarPanels = true
    const applicationsWithoutSolarPanelPics = await db
      .select({
        applicationId: applications.id,
      })
      .from(applications)
      .leftJoin(
        Documents,
        and(
          eq(Documents.applicationId, applications.id),
          like(Documents.name, "%after_install_pictures%"),
          eq(Documents.isShowingSolarPanels, true)
        )
      )
      .where(
        and(eq(applications.status, "completed"), sql`${Documents.id} IS NULL`)
      );

    if (applicationsWithoutSolarPanelPics.length === 0) {
      console.log(
        "✅ No completed applications found with missing solar panel pictures."
      );
      return;
    }

    console.log(
      `Found ${applicationsWithoutSolarPanelPics.length} applications\n`
    );

    // Collect all after-install pictures
    const allDocuments: Array<{
      id: string;
      applicationId: string;
      url: string;
      name: string;
    }> = [];
    for (const app of applicationsWithoutSolarPanelPics) {
      const afterInstallPictures = await db.query.Documents.findMany({
        where: (doc, { and, like, notInArray, eq: eqOp }) =>
          and(
            eqOp(doc.applicationId, app.applicationId),
            like(doc.name, "%after_install_pictures%"),
            notInArray(doc.type, ["heic", "HEIC"])
          ),
      });

      allDocuments.push(
        ...afterInstallPictures.map((doc) => ({
          id: doc.id,
          applicationId: doc.applicationId,
          url: doc.url,
          name: doc.name,
        }))
      );
    }

    console.log(`📸 Total images to analyze: ${allDocuments.length}\n`);

    if (allDocuments.length === 0) {
      console.log("No images to process!");
      return;
    }

    // Create batch requests for OpenAI
    const batchRequests = allDocuments.map((doc, index) => ({
      custom_id: `${doc.applicationId}_${index}_${doc.id}`,
      method: "POST" as const,
      url: "/v1/chat/completions",
      body: {
        model: "gpt-4o-mini",
        max_completion_tokens: 100,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: 'Does this image clearly show one or more solar panels? Reply with "yes" or "no" and rate your confidence (low/medium/high).',
              },
              {
                type: "image_url",
                image_url: { url: doc.url },
              },
            ],
          },
        ],
      },
    }));

    // Save batch requests to file
    const timestamp = Date.now();
    const requestsFile = `batch-solar-panels-${timestamp}.jsonl`;
    const requestsContent = batchRequests
      .map((r) => JSON.stringify(r))
      .join("\n");

    fs.writeFileSync(path.join(process.cwd(), requestsFile), requestsContent);
    console.log(`📄 Saved ${batchRequests.length} requests to ${requestsFile}`);

    // Upload file to OpenAI
    console.log("\n📤 Uploading batch file...");
    const file = await openai.files.create({
      file: fs.createReadStream(path.join(process.cwd(), requestsFile)),
      purpose: "batch",
    });
    console.log(`✅ File uploaded: ${file.id}`);

    // Create batch
    console.log("\n🔄 Creating batch job...");
    const batch = await openai.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
      metadata: {
        description: "Solar panel detection for after-install pictures",
        total_images: batchRequests.length.toString(),
        timestamp: timestamp.toString(),
      },
    });

    console.log(`\n✅ Batch created successfully!`);
    console.log(`📋 Batch ID: ${batch.id}`);
    console.log(`📊 Status: ${batch.status}`);
    console.log(
      `💰 Estimated cost: ~$${(batchRequests.length * 0.000075).toFixed(
        4
      )} (with 50% batch discount)`
    );

    // Create image map for later reference
    const imageMap = allDocuments.reduce((acc, doc, index) => {
      const customId = `${doc.applicationId}_${index}_${doc.id}`;
      acc[customId] = {
        documentId: doc.id,
        applicationId: doc.applicationId,
        url: doc.url,
        name: doc.name,
      };
      return acc;
    }, {} as Record<string, { documentId: string; applicationId: string; url: string; name: string }>);

    // Save batch info for later retrieval
    const batchInfo = {
      batchId: batch.id,
      fileId: file.id,
      imageMap,
      createdAt: new Date().toISOString(),
      totalRequests: batchRequests.length,
    };

    const batchInfoFile = `batch-info-${batch.id}.json`;
    fs.writeFileSync(
      path.join(process.cwd(), batchInfoFile),
      JSON.stringify(batchInfo, null, 2)
    );
    console.log(`\n💾 Batch info saved to ${batchInfoFile}`);

    // Clean up temporary file
    fs.unlinkSync(path.join(process.cwd(), requestsFile));

    console.log(`\n\n📋 Next steps:`);
    console.log(
      `1. Wait for batch completion (up to 24 hours, usually much faster)`
    );
    console.log(
      `2. Check status: bun run scripts/check-batch-status.ts ${batch.id}`
    );
    console.log(
      `3. Retrieve results: bun run scripts/retrieve-batch-results.ts ${batch.id}`
    );
  } catch (error) {
    console.error("❌ Error creating batch job:", error);
    throw error;
  } finally {
    process.exit(0);
  }
}

// Run the script
createBatchJob();
