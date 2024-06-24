import { db } from "../../db";
import { RoleInsertType, RolePermissions, Roles } from "../../schema";

export const createOrganizationRole = async (
  role: RoleInsertType,
  permissions: { id: string }[]
) => {
  const roleRes = await db
    .insert(Roles)
    .values({
      ...role,
      createdAt: new Date(),
    })
    .returning({ insertedId: Roles.id });

  await db.insert(RolePermissions).values(
    permissions.map((permission) => ({
      roleId: roleRes[0].insertedId,
      permissionId: permission.id,
    }))
  );

  return roleRes[0].insertedId;
};
