import { db } from "../../db";
import { findAllPermissions } from "../../queries/permissions/findAllPermissions";
import {
  OrganizationInsertType,
  OrganizationUserInsertType,
  OrganizationUsers,
  Organizations,
  RolePermissions,
  Roles,
} from "../../schema";

export const createOrganization = async (
  organization: OrganizationInsertType,
  signature: string
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
      isReadOnly: true,
    })
    .returning({ insertedId: Roles.id });

  const permissions = await findAllPermissions();

  await db.insert(RolePermissions).values(
    permissions.map((permission) => ({
      roleId: roleRes[0].insertedId,
      permissionId: permission.id,
    }))
  );

  const orgOwner: OrganizationUserInsertType = {
    organizationId: res[0].insertedId,
    userId: organization.ownerId,
    roleId: roleRes[0].insertedId,
    invitedAt: new Date(),
    joinedAt: new Date(),
    signature,
    hasDocumentsAccess: true,
    isAccepted: true,
    isOwner: true,
  };

  await db.insert(OrganizationUsers).values(orgOwner);

  return res[0].insertedId;
};
