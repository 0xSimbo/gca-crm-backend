import { db } from "../../db";

export const findAllGcas = async () => {
  const gcas = await db.query.Gcas.findMany({
    columns: {
      id: true,
      email: true,
      publicEncryptionKey: true,
    },
  });
  return gcas;
};
