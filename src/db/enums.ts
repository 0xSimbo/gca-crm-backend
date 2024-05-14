import { pgEnum } from "drizzle-orm/pg-core";
import {
  applicationStatus,
  contactTypes,
  optionalDocuments,
  roundRobinStatus,
} from "../types/api-types/Application";

// UNKNOWN is a special role that is used when the user didn't yet filled the onboarding form
export const accountRoles = ["USER", "GCA", "ADMIN", "UNKNOWN"] as const;

export const accountRoleEnum = pgEnum("role", accountRoles);

export const contactTypesEnum = pgEnum("contact_types", contactTypes);

export const roundRobinStatusEnum = pgEnum(
  "round_robin_status",
  roundRobinStatus
);

export const applicationStatusEnum = pgEnum(
  "application_status",
  applicationStatus
);

export const optionalDocumentsEnum = pgEnum(
  "optional_documents",
  optionalDocuments
);
