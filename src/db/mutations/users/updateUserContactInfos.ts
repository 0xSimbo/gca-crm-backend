import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../schema";
import { ContactType } from "../../../types/api-types/Application";

export const updateUserContactInfos = async (
  contactInfos: {
    contactType: ContactType;
    contactValue: string;
  },
  userId: string
) => {
  return await db
    .update(users)
    .set({
      contactType: contactInfos.contactType,
      contactValue: contactInfos.contactValue,
    })
    .where(eq(users.id, userId));
};
