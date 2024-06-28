import { db } from "../../db";
import { RolePermissions } from "../../schema";

export const updateOrganizationRolePermissions = async (
  roleId: string,
  permissions: { id: string }[]
) => {
  await db.insert(RolePermissions).values(
    permissions.map((permission) => ({
      roleId: roleId,
      permissionId: permission.id,
    }))
  );
};
