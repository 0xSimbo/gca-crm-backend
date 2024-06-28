import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents } from "../../schema";

export const findFirstDocumentById = async (id: string) => {
  const document = await db.query.Documents.findFirst({
    where: eq(Documents.id, id),
    with: {
      application: {
        columns: {
          id: true,
          userId: true,
        },
      },
    },
  });
  return document;
};
