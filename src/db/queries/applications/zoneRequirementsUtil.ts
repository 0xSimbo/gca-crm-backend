import { eq } from "drizzle-orm";
import { requirementSetCodes, requirementSetMap } from "../../zones";
import { db } from "../../db";
import {
  ApplicationEnquiryFieldsCRSInsertType,
  ApplicationAuditFieldsCRSInsertType,
} from "../../schema";

export async function getZoneRequirementFields({
  applicationId,
  requirementSetCode,
}: {
  applicationId: string;
  requirementSetCode: (typeof requirementSetCodes)[number];
}): Promise<{
  enquiryFields: ApplicationEnquiryFieldsCRSInsertType | null;
  auditFields: ApplicationAuditFieldsCRSInsertType | null;
}> {
  let enquiryFields: ApplicationEnquiryFieldsCRSInsertType | null = null;
  let auditFields: ApplicationAuditFieldsCRSInsertType | null = null;
  if (requirementSetCode) {
    const enquiryTable = requirementSetMap[requirementSetCode].enquiry;
    const auditTable = requirementSetMap[requirementSetCode].audit;

    enquiryFields = await db
      .select()
      .from(enquiryTable)
      .where(eq(enquiryTable.applicationId, applicationId))
      .then((rows: ApplicationEnquiryFieldsCRSInsertType[]) => rows[0] ?? null);

    auditFields = await db
      .select()
      .from(auditTable)
      .where(eq(auditTable.applicationId, applicationId))
      .then((rows: ApplicationAuditFieldsCRSInsertType[]) => rows[0] ?? null);
  }
  return { enquiryFields, auditFields };
}
