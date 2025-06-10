import { db } from "../../db";
import { applicationsDraft } from "../../schema";
import { eq, notInArray, and } from "drizzle-orm";
import { applications } from "../../schema";

export async function findFirstApplicationDraftByUserId(userId: string) {
  // Find all application ids
  const existingApplicationIds = await db
    .select({ id: applications.id })
    .from(applications);
  const applicationIds = existingApplicationIds.map((a) => a.id);

  const draft = await db
    .select()
    .from(applicationsDraft)
    .where(
      and(
        eq(applicationsDraft.userId, userId),
        notInArray(applicationsDraft.id, applicationIds)
      )
    )
    .orderBy(applicationsDraft.createdAt)
    .limit(1);
  return draft[0] || null;
}
