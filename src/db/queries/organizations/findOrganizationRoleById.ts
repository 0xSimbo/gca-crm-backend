import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Roles } from "../../schema";

export const findOrganizationRoleById = async (id: string) => {
  const organizationRoleDb = await db.query.Roles.findFirst({
    where: eq(Roles.id, id),
    with: {
      rolePermissions: {
        with: {
          permission: true,
        },
      },
    },
  });
  return organizationRoleDb;
};
