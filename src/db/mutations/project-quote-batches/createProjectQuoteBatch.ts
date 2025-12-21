import { db } from "../../db";
import {
  ProjectQuoteBatches,
  type ProjectQuoteBatchInsertType,
} from "../../schema";

export async function createProjectQuoteBatch(
  data: ProjectQuoteBatchInsertType
) {
  const [created] = await db
    .insert(ProjectQuoteBatches)
    .values(data)
    .returning();
  if (!created) {
    throw new Error("Failed to create project quote batch");
  }
  return created;
}
