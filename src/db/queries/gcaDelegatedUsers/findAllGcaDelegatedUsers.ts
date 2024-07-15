import { eq } from "drizzle-orm";
import { db } from "../../db";
import { GcaDelegatedUsers } from "../../schema";

export const findAllGcaDelegatedUsers = async (gcaId: string) => {
  const gcaDelegatedUsers = await db.query.GcaDelegatedUsers.findMany({
    where: eq(GcaDelegatedUsers.gcaId, gcaId),
    with: {
      user: {
        columns: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          publicEncryptionKey: true,
          encryptedPrivateEncryptionKey: true,
        },
      },
    },
  });
  return gcaDelegatedUsers;
};
