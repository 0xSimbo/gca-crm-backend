import { getFarmNamesByApplicationIds } from "../src/db/queries/farms/getFarmNamesByApplicationIds";

/**
 * Get farm name for a given application ID
 * Usage: bun run scripts/get-farm-name-by-application-id.ts <application_id>
 */
async function getFarmName() {
  try {
    const applicationId = process.argv[2];

    if (!applicationId) {
      console.error("❌ Please provide an application ID");
      console.log(
        "Usage: bun run scripts/get-farm-name-by-application-id.ts <application_id>"
      );
      process.exit(1);
    }

    console.log(`🔍 Looking up farm name for application: ${applicationId}\n`);

    const farmNamesMap = await getFarmNamesByApplicationIds([applicationId]);

    const farmName = farmNamesMap.get(applicationId);

    if (!farmName) {
      console.log(`❌ No farm name found for application ID: ${applicationId}`);
      console.log(
        `Note: This could mean the application doesn't exist or has no associated farm.`
      );
    } else {
      console.log(`📊 Farm Name Information`);
      console.log(`${"=".repeat(50)}`);
      console.log(`Application ID: ${applicationId}`);
      console.log(`Farm Name:      ${farmName}`);
      console.log(`${"=".repeat(50)}`);
    }
  } catch (error: any) {
    console.error("❌ Error getting farm name:", error.message);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

getFarmName();





