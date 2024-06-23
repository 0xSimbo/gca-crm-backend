import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Roles } from "../../schema";

export const findAllOrganizationRoles = async (organizationId: string) => {
  const organizationRolesDb = await db.query.Roles.findMany({
    where: eq(Roles.organizationId, organizationId),
    with: {
      rolePermissions: {
        with: {
          permission: true,
        },
      },
    },
  });
  return organizationRolesDb;
};
