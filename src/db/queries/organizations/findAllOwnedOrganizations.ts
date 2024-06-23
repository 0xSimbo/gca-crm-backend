import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Organizations } from "../../schema";

export const findAllOwnedOrganizations = async (userId: string) => {
  const organizationDb = await db.query.Organizations.findMany({
    where: eq(Organizations.ownerId, userId),
  });
  return organizationDb;
};
