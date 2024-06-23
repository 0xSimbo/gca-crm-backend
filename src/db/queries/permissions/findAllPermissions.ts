import { db } from "../../db";

export const findAllPermissions = async () => {
  return await db.query.Permissions.findMany();
};
