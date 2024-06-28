import { eq } from "drizzle-orm";
import { db } from "../../db";
import { RolePermissions } from "../../schema";

export const updateOrganizationRolePermissions = async (
  roleId: string,
  permissions: { id: string }[]
) => {
  await db.delete(RolePermissions).where(eq(RolePermissions.roleId, roleId));
  await db.insert(RolePermissions).values(
    permissions.map((permission) => ({
      roleId,
      permissionId: permission.id,
    }))
  );
};
