import { inArray, eq } from "drizzle-orm";
import { db } from "../../db";
import { applications, farms } from "../../schema";
import { getDeterministicStarNameForApplicationId } from "../../../routers/farms/helpers";

export async function getFarmNamesByApplicationIds(applicationIds: string[]) {
  if (applicationIds.length === 0) return new Map<string, string>();

  const rows = await db
    .select({ applicationId: applications.id, farmName: farms.name })
    .from(applications)
    .leftJoin(farms, eq(applications.farmId, farms.id))
    .where(inArray(applications.id, applicationIds));

  const map = new Map<string, string>();
  for (const row of rows) {
    const resolvedName =
      row.farmName ??
      getDeterministicStarNameForApplicationId(row.applicationId);
    map.set(row.applicationId, resolvedName ?? "");
  }
  return map;
}
