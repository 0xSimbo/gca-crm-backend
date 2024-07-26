import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const findFirstOrgMemberwithShareAllApplications = async (
  userId: string
) => {
  return await db.query.OrganizationUsers.findFirst({
    where: and(
      eq(OrganizationUsers.shareAllApplications, true),
      eq(OrganizationUsers.userId, userId)
    ),
  });
};
