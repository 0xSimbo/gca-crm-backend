import { eq } from "drizzle-orm";
import { db } from "../../db";
import { Documents } from "../../schema";

export const updateDocumentWithAnnotation = async (
  annotation: string,
  documentId: string
) => {
  return await db
    .update(Documents)
    .set({
      annotation: annotation,
    })
    .where(eq(Documents.id, documentId));
};
