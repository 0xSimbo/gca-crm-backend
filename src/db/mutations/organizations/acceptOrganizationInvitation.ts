import { eq } from "drizzle-orm";
import { db } from "../../db";
import { OrganizationUsers } from "../../schema";

export const acceptOrganizationInvitation = async (
  signature: string,
  organizationUserId: string
) => {
  const res = await db
    .update(OrganizationUsers)
    .set({
      joinedAt: new Date(),
      signature: signature,
      isAccepted: true,
    })
    .where(eq(OrganizationUsers.id, organizationUserId))
    .returning({ isAccepted: OrganizationUsers.isAccepted });

  if (res[0].isAccepted === false) {
    throw new Error("Failed to accept organization invitation");
  }
};
