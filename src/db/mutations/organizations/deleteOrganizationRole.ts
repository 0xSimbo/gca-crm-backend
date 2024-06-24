import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Roles } from "../../schema";

export const deleteOrganizationRole = async (roleId: string) => {
  await db.delete(Roles).where(eq(Roles.id, roleId));
};
