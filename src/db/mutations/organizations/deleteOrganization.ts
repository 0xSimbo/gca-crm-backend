import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Organizations } from "../../schema";

export const deleteOrganization = async (organizationId: string) => {
  await db.delete(Organizations).where(eq(Organizations.id, organizationId));
};
