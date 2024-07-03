import { eq } from "drizzle-orm";
import { db } from "../../db";
import { RolePermissions } from "../../schema";

export const updateOrganizationRolePermissions = async (
  roleId: string,
  permissions: { id: string }[]
) => {
  db.transaction(async (tx) => {
    await tx.delete(RolePermissions).where(eq(RolePermissions.roleId, roleId));
    await tx.insert(RolePermissions).values(
      permissions.map((permission) => ({
        roleId,
        permissionId: permission.id,
      }))
    );
  });
};
