import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  ApplicationAuditFieldsCRSInsertType,
  ApplicationEnquiryFieldsCRSInsertType,
  ApplicationInsertType,
  applications,
  applicationsAuditFieldsCRS,
  applicationsEnquiryFieldsCRS,
} from "../../schema";

export const updateApplication = async (
  applicationId: string,
  fields: Partial<ApplicationInsertType>
) => {
  return await db
    .update(applications)
    .set({
      ...fields,
    })
    .where(eq(applications.id, applicationId));
};

export const updateApplicationCRSFields = async (
  applicationId: string,
  enquiryFields: Partial<ApplicationEnquiryFieldsCRSInsertType>,
  auditFields: Partial<ApplicationAuditFieldsCRSInsertType>
) => {
  return db.transaction(async (tx) => {
    await tx
      .update(applicationsEnquiryFieldsCRS)
      .set({
        ...enquiryFields,
      })
      .where(eq(applicationsEnquiryFieldsCRS.id, applicationId));

    await tx
      .update(applicationsAuditFieldsCRS)
      .set({
        ...auditFields,
      })
      .where(eq(applicationsAuditFieldsCRS.id, applicationId));
  });
};
