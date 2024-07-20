import { db } from "../../db";

export const findAllGcas = async () => {
  const gcas = await db.query.Gcas.findMany({
    columns: {
      id: true,
      email: true,
      publicEncryptionKey: true,
    },
    with: {
      delegatedUsers: {
        columns: {
          id: true,
          userId: true,
        },
        with: {
          user: {
            columns: {
              publicEncryptionKey: true,
            },
          },
        },
      },
    },
  });
  return gcas;
};
