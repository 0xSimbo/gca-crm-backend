import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { applications } from "../../schema";
import { ContactType } from "../../../types/api-types/Application";

export const updateApplicationContactInfos = async (
  contactInfos: {
    contactType: ContactType;
    contactValue: string;
  },
  applicationId: string,
  userId: string
) => {
  return await db
    .update(applications)
    .set({
      contactType: contactInfos.contactType,
      contactValue: contactInfos.contactValue,
    })
    .where(
      and(eq(applications.id, applicationId), eq(applications.userId, userId))
    );
};
