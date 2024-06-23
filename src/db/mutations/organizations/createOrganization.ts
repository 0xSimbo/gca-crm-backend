import { db } from "../../db";
import { findAllPermissions } from "../../queries/permissions/findAllPermissions";
import {
  OrganizationInsertType,
  Organizations,
  RolePermissions,
  Roles,
} from "../../schema";

export const createOrganization = async (
  organization: OrganizationInsertType
) => {
  const res = await db
    .insert(Organizations)
    .values(organization)
    .returning({ insertedId: Organizations.id });

  if (res.length === 0) {
    throw new Error("Failed to insert Organization");
  }

  const roleRes = await db
    .insert(Roles)
    .values({
      organizationId: res[0].insertedId,
      name: "Admin",
      createdAt: new Date(),
    })
    .returning({ insertedId: Roles.id });

  const permissions = await findAllPermissions();

  await db.insert(RolePermissions).values(
    permissions.map((permission) => ({
      roleId: roleRes[0].insertedId,
      permissionId: permission.id,
    }))
  );

  return res[0].insertedId;
};
