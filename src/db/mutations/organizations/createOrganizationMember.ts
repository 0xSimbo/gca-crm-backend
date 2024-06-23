import { db } from "../../db";
import { OrganizationUserInsertType, OrganizationUsers } from "../../schema";

export const createOrganizationMember = async (
  organizationUser: OrganizationUserInsertType
) => {
  const res = await db
    .insert(OrganizationUsers)
    .values(organizationUser)
    .returning({ insertedId: OrganizationUsers.id });

  if (res.length === 0) {
    throw new Error("Failed to insert organizationUser");
  }
};
