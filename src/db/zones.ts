import {
  applicationsAuditFieldsCRS,
  applicationsEnquiryFieldsCRS,
} from "./schema";

export const requirementSetCodes = ["CRS"] as const;

/**
 * @dev Map of requirement sets to their corresponding enquiry and audit fields
 */
export const requirementSetMap = {
  CRS: {
    enquiry: applicationsEnquiryFieldsCRS,
    enquiryColumnsSelect: {
      address: true,
      installerCompanyName: true,
      installerEmail: true,
      installerPhone: true,
      installerName: true,
      farmOwnerName: true,
      farmOwnerEmail: true,
      farmOwnerPhone: true,
    },
    audit: applicationsAuditFieldsCRS,
  },
  // XYZ: { enquiry: applicationXyzEnquiry, audit: applicationXyzAudit },
} as const;
