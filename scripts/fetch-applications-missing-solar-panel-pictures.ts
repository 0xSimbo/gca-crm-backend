import { db } from "../src/db/db";
import { applications, Documents } from "../src/db/schema";
import { sql, eq, and, like, notInArray } from "drizzle-orm";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface DocumentWithScore {
  documentId: string;
  applicationId: string;
  url: string;
  name: string;
  hasSolarPanels: boolean;
  confidence: string;
}

/**
 * Analyzes a document to determine if it shows solar panels with retry logic
 */
async function analyzeDocument(
  doc: {
    id: string;
    applicationId: string;
    url: string;
    name: string;
  },
  retries = 3
): Promise<DocumentWithScore> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_completion_tokens: 1000,
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
      });

      const content =
        response.choices[0]?.message?.content?.toLowerCase() || "";
      const hasSolarPanels = content.includes("yes");

      let confidence = "low";
      if (content.includes("high")) confidence = "high";
      else if (content.includes("medium")) confidence = "medium";

      // Debug: log the AI response
      console.log(`     AI Response: "${content}"`);

      return {
        documentId: doc.id,
        applicationId: doc.applicationId,
        url: doc.url,
        name: doc.name,
        hasSolarPanels,
        confidence,
      };
    } catch (error: any) {
      const isRateLimit = error?.code === "rate_limit_exceeded";

      if (isRateLimit && attempt < retries) {
        const waitTime = Math.pow(2, attempt) * 2000;
        console.log(
          `  ⏳ Rate limit hit, waiting ${waitTime / 1000}s before retry ${
            attempt + 1
          }/${retries}...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }

      if (attempt === retries) {
        console.error(`  ❌ Failed after ${retries} retries:`, error.message);
        return {
          documentId: doc.id,
          applicationId: doc.applicationId,
          url: doc.url,
          name: doc.name,
          hasSolarPanels: false,
          confidence: "low",
        };
      }
    }
  }

  return {
    documentId: doc.id,
    applicationId: doc.applicationId,
    url: doc.url,
    name: doc.name,
    hasSolarPanels: false,
    confidence: "low",
  };
}

/**
 * Script to fetch all completed applications that have 0 documents with:
 * - "after_install_pictures" in their name
 * - isShowingSolarPanels = true
 * Then identifies and tags the 3 best pictures showing solar panels
 */
async function fetchApplicationsMissingSolarPanelPictures() {
  try {
    console.log(
      "Fetching completed applications missing solar panel pictures...\n"
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
      return [];
    }

    console.log(
      `Found ${applicationsWithoutSolarPanelPics.length} completed applications missing solar panel pictures:\n`
    );

    let totalProcessed = 0;
    let totalTagged = 0;

    // Process each application (limit to first 1 for debugging)
    for (const app of applicationsWithoutSolarPanelPics.slice(0, 1)) {
      console.log(`\n📋 Processing application: ${app.applicationId}`);

      // Fetch all after_install_pictures for this application (excluding HEIC)
      const afterInstallPictures = await db.query.Documents.findMany({
        where: (doc, { and, like, notInArray, eq: eqOp }) =>
          and(
            eqOp(doc.applicationId, app.applicationId),
            like(doc.name, "%after_install_pictures%"),
            notInArray(doc.type, ["heic", "HEIC"])
          ),
      });

      if (afterInstallPictures.length === 0) {
        console.log(`  ⚠️  No after-install pictures found (or all are HEIC)`);
        continue;
      }

      console.log(
        `  Found ${afterInstallPictures.length} pictures to analyze...`
      );

      // Analyze all pictures (limit to first 3 for debugging)
      const results: DocumentWithScore[] = [];
      for (const doc of afterInstallPictures.slice(0, 3)) {
        console.log(`  🔍 Analyzing: ${doc.name}`);
        console.log(`     URL: ${doc.url}`);
        const result = await analyzeDocument({
          id: doc.id,
          applicationId: doc.applicationId,
          url: doc.url,
          name: doc.name,
        });
        results.push(result);

        // Delay to avoid rate limiting (2 seconds between requests)
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Filter and sort by confidence (high > medium > low)
      const withSolarPanels = results.filter((r) => r.hasSolarPanels);

      if (withSolarPanels.length === 0) {
        console.log(`  ⚠️  No pictures showing solar panels found`);
        continue;
      }

      const confidenceOrder = { high: 3, medium: 2, low: 1 };
      const sortedBest = withSolarPanels
        .sort(
          (a, b) =>
            confidenceOrder[b.confidence as keyof typeof confidenceOrder] -
            confidenceOrder[a.confidence as keyof typeof confidenceOrder]
        )
        .slice(0, 3);

      console.log(
        `  ✅ Found ${withSolarPanels.length} pictures with solar panels`
      );
      console.log(`  🏆 Tagging top ${sortedBest.length} pictures:`);

      // Update the top 3 documents
      for (const doc of sortedBest) {
        await db
          .update(Documents)
          .set({
            isShowingSolarPanels: true,
            updatedAt: new Date(),
          })
          .where(eq(Documents.id, doc.documentId));

        console.log(`     - ${doc.name} (${doc.confidence} confidence)`);
        totalTagged++;
      }

      totalProcessed++;
    }

    console.log(`\n\n📊 Summary:`);
    console.log(`   Total applications processed: ${totalProcessed}`);
    console.log(`   Total pictures tagged: ${totalTagged}`);

    return applicationsWithoutSolarPanelPics;
  } catch (error) {
    console.error("❌ Error fetching applications:", error);
    throw error;
  } finally {
    process.exit(0);
  }
}

// Run the script
fetchApplicationsMissingSolarPanelPictures();
