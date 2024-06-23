import { db } from "../../db";
import { PermissionInsertType, Permissions } from "../../schema";

export const createPermission = async (permission: PermissionInsertType) => {
  const res = await db
    .insert(Permissions)
    .values(permission)
    .returning({ insertedId: Permissions.id });

  if (res.length === 0) {
    throw new Error("Failed to insert Permission");
  }

  return res[0].insertedId;
};
