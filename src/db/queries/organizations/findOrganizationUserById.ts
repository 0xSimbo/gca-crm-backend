import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findOrganizationUserById = async (id: string) => {
  const organizationUserDb = await db.query.OrganizationUsers.findFirst({
    where: eq(OrganizationUsers.id, id),
  });
  return organizationUserDb;
};
