import {
  pgTable,
  varchar,
  integer,
  primaryKey,
  bigint,
  pgEnum,
  timestamp,
  text,
  index,
  json,
  boolean,
  numeric,
} from "drizzle-orm/pg-core";
import { relations, type InferSelectModel, sql } from "drizzle-orm";
import { EncryptedMasterKeySet } from "../types/api-types/Application";
import {
  accountRoleEnum,
  applicationStatusEnum,
  contactTypesEnum,
  optionalDocumentsEnum,
  roundRobinStatusEnum,
} from "./enums";

// db diagram here : https://app.eraser.io/workspace/Ro75vSbOwABbdvKvyTFJ?origin=share @0xSimbo

export type FarmUpdate = {
  previousValue: any;
  updatedValue: any;
};

//TODO: finish
// export type QuoteEstimate = {
//   previousValue: any;
//   updatedValue: any;
// };

/**
    * @dev
    Rewards in the database are stored in 2 decimals.
    Even though Glow is in 18 decimals on-chain, we store it in 2 decimals in the database.
    This is to fit SQL bigint limits.
    Example: 1 Glow = 100 in the database
    The same follows for USDG
    Example: 1 USDG = 100 in the database

    While rewards are stored in 2 decimals, the `weights` are stored as raw values.
    Weights are created by the GCAs in the weekly reports. We get these weights directly from
    the merkletrees that the GCAs provide. Those are stored raw and have 6 decimals of precision
    which should fit within the SQL bigint limits.
    The max bigint value in SQL is 2**63 - 1 = 9223372036854775807
    If GCAs provide weights with 6 decimals, that means that a single bucket would need more than
    $9,223,372,036,854.775807 as a reward for a single solar farm. We're not there yet.

*/

/**
 * @dev We keep aggregate counters to avoid needing to calculate them on the fly.
 * @param {string} id - The ethereum wallet address.
 * @param {BigInt} totalUSDGRewards - The total USDG rewards of the user in 2 Decimals
            - USDG/USDC is in 6 decimals, but for the database, we use 2 decimals
            - because of SQL's integer limit.
            - We could save strings, but we may want some calculations in the database at some point
            - Example: totalUSDGRewards * 100 is $1
 * @param {BigInt} totalGlowRewards - The total Glow rewards of the user.
            - Follows same logic as above. 2 Decimals
            - Even though Glow is 18 Decimals On-Chain
 */
export const wallets = pgTable("wallets", {
  id: varchar("wallet_id", { length: 42 }).primaryKey().notNull(),
  totalUSDGRewards: bigint("total_usdg_rewards", { mode: "bigint" })
    .default(sql`'0'::bigint`)
    .notNull(),
  totalGlowRewards: bigint("total_glow_rewards", { mode: "bigint" })
    .default(sql`'0'::bigint`)
    .notNull(),
});

/**
 * @dev Each wallets has an array of weekly rewards.
 */
export const WalletsRelations = relations(wallets, ({ many }) => ({
  weeklyRewards: many(walletWeeklyRewards),
}));

export type WalletType = InferSelectModel<typeof wallets>;
export type WalletWeeklyRewardType = InferSelectModel<
  typeof walletWeeklyRewards
>;

/**
 * @param {string} id - The ethereum wallet address.
 * @param {number} weekNumber - The week number of the rewards
 * @param {BigInt} usdgWeight - The total USDG Rewards weight for the user that is published in the merkle root
 * @param {BigInt} glowWeight - The total Glow Rewards weight for the user that is published in the merkle root
 * @param {BigInt} usdgRewards - The total USDG rewards of the user in 2 Decimals
 * @param {BigInt} glowRewards  - The total Glow rewards of the user in 2 Decimals
 * @param {number} indexInReports - Index in the report for tracking purposes.
 * @param {string[]} claimProof - Array of proofs required for claiming rewards.
 */
export const walletWeeklyRewards = pgTable(
  "wallet_weekly_rewards",
  {
    id: varchar("wallet_id", { length: 42 })
      .notNull()
      .references(() => wallets.id, { onDelete: "cascade" }),
    weekNumber: integer("week_number").notNull(),
    usdgWeight: bigint("usdg_weight", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    glowWeight: bigint("glow_weight", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    usdgRewards: bigint("usdg_rewards", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    glowRewards: bigint("glow_rewards", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    indexInReports: integer("index_in_reports").notNull(),
    claimProof: varchar("claim_proof", { length: 66 }).array().notNull(),
  },
  (t) => {
    return {
      pk: primaryKey({ columns: [t.id, t.weekNumber] }),
      walletIdToWeekNumberIndex: index("wallet_id_to_week_number_ix").on(
        t.id,
        t.weekNumber
      ),
    };
  }
);

/**
 * @dev Each wallet weekly reward has a wallet.
 * @dev This is a one-to-many relationship.
 * @dev Each wallet can have multiple weekly rewards.
 * @dev Each weekly reward belongs to a single wallet.
 */
export const WalletWeeklyRewardRelations = relations(
  walletWeeklyRewards,
  ({ one }) => ({
    user: one(wallets, {
      fields: [walletWeeklyRewards.id],
      references: [wallets.id],
    }),
  })
);

/**
 * @dev Represents a farm in the system.
 * @param {string} id - The hexlified farm public key.
 * @param {number} shortId - A short ID for simplicity and readability.
 * @param {BigInt} totalGlowRewards - The total Glow rewards of the farm in 2 Decimals.
 * @param {BigInt} totalUSDGRewards - The total USDG rewards of the farm in 2 Decimals.
 * @param {timestamp} createdAt - The creation date of the farm.
 * @param {timestamp} auditCompleteDate - The date when the farm audit was completed.
 * @param {string} gcaId - The GCA (Green Certificate Authority) ID.
 * @param {string} userId - The user ID who owns the farm.
 */
export const farms = pgTable(
  "farms",
  {
    id: varchar("farm_id", { length: 66 }).primaryKey(), // hexlified farm pub key
    shortId: integer("short_id").notNull(), // short id for simplicity and readability
    totalGlowRewards: bigint("total_glow_rewards", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    totalUSDGRewards: bigint("total_usdg_rewards", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    auditCompleteDate: timestamp("audit_complete_date"),
    gcaId: varchar("gca_id", { length: 42 }).notNull(),
    userId: varchar("user_id", { length: 42 }).notNull(),
  },
  (t) => {
    return {
      shortIdIndex: index("short_id_ix").on(t.shortId),
      farmIdIndex: index("farm_id_ix").on(t.id),
    };
  }
);
export type FarmDatabaseType = InferSelectModel<typeof farms>;
export type FarmDatabaseInsertType = typeof farms.$inferInsert;

export const FarmRelations = relations(farms, ({ many, one }) => ({
  farmRewards: many(farmRewards),
  rewardSplits: many(RewardSplits),
  user: one(users, {
    fields: [farms.userId],
    references: [users.id],
  }),
  gca: one(Gcas, {
    fields: [farms.gcaId],
    references: [Gcas.id],
  }),
  farmUpdatesHistory: many(farmUpdatesHistory),
}));

/**
 * @dev Represents the history of updates made to a farm.
 * @param {string} id - The unique ID of the update.
 * @param {string} farmId - The ID of the farm that was updated.
 * @param {timestamp} updatedAt - The date and time when the update was made.
 * @param {string} updatedBy - The wallet address of the user who made the update.
 * @param {json} update - The details of the update.
 */
export const farmUpdatesHistory = pgTable(
  "farm_updates_history",
  {
    id: text("update_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    farmId: varchar("farm_id", { length: 66 })
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    updatedBy: varchar("updated_by", { length: 42 }).notNull(), // the wallet address of the user that made the update
    update: json("update").$type<FarmUpdate>().notNull(),
  },
  (t) => {
    return {
      farmIdUpdatedByIndex: index("farm_id_updated_by_ix").on(
        t.farmId,
        t.updatedBy
      ),
    };
  }
);

export type FarmUpdatesHistoryDatabaseType = InferSelectModel<
  typeof farmUpdatesHistory
>;
export type FarmUpdatesHistoryInsertType =
  typeof farmUpdatesHistory.$inferInsert;

export const FarmUpdatesHistoryRelations = relations(
  farmUpdatesHistory,
  ({ one }) => ({
    farm: one(farms, {
      fields: [farmUpdatesHistory.farmId],
      references: [farms.id],
    }),
  })
);

/**
 * @dev Represents the rewards of a farm for a specific week.
 * @param {string} hexlifiedFarmPubKey - The hexlified farm public key.
 * @param {number} weekNumber - The week number of the rewards.
 * @param {BigInt} usdgRewards - The total USDG rewards of the farm in 2 Decimals.
 * @param {BigInt} glowRewards - The total Glow rewards of the farm in 2 Decimals.
 */
export const farmRewards = pgTable(
  "farm_rewards",
  {
    hexlifiedFarmPubKey: varchar("farm_id", { length: 66 }).notNull(),
    weekNumber: integer("week_number").notNull(),
    usdgRewards: bigint("usdg_rewards", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    glowRewards: bigint("glow_rewards", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
  },
  (t) => {
    return {
      pk: primaryKey({ columns: [t.hexlifiedFarmPubKey, t.weekNumber] }),
    };
  }
);

export type FarmRewardsDatabaseType = InferSelectModel<typeof farmRewards>;
export type FarmRewardsInsertType = typeof farmRewards.$inferInsert;

export const FarmRewardsRelations = relations(farmRewards, ({ one }) => ({
  farm: one(farms, {
    fields: [farmRewards.hexlifiedFarmPubKey],
    references: [farms.id],
  }),
}));

/**
 * @dev Represents an account in the system.
 * @param {string} id - The ethereum wallet address.
 * @param {string} role - The role of the account.
 * @param {timestamp} created_at - The creation date of the account.
 * @param {string} siweNonce - The nonce for SIWE (Sign-In with Ethereum).
 */
export const Accounts = pgTable("accounts", {
  id: varchar("wallet_id", { length: 42 }).primaryKey().notNull(),
  role: accountRoleEnum("role"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  siweNonce: varchar("nonce", { length: 64 }).notNull(),
  salt: varchar("salt", { length: 255 }).notNull(),
});

export type AccountInsertType = typeof Accounts.$inferInsert;
export type AccountType = InferSelectModel<typeof Accounts>;

export const accountsRelations = relations(Accounts, ({ one }) => ({
  user: one(users, {
    fields: [Accounts.id],
    references: [users.id],
  }),
  gca: one(Gcas, {
    fields: [Accounts.id],
    references: [Gcas.id],
  }),
}));

/**
 * @dev Represents a user in the system.
 * @param {string} id - The ethereum wallet address.
 * @param {timestamp} created_at - The creation date of the user.
 * @param {string} firstName - The first name of the user.
 * @param {string} lastName - The last name of the user.
 * @param {string} email - The email of the user.
 * @param {string} companyName - The company name of the user.
 * @param {string} salt - The salt used for encryption.
 * @param {string} publicEncryptionKey - The public encryption key of the user.
 * @param {string} encryptedPrivateEncryptionKey - The encrypted private encryption key of the user.
 * @param {string} companyAddress - The company address of the user.
 * @param {boolean} isInstaller - Indicates if the user is an installer.
 */
export const users = pgTable("users", {
  id: varchar("wallet", { length: 42 })
    .primaryKey()
    .notNull()
    .references(() => Accounts.id, { onDelete: "cascade" }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  firstName: varchar("first_name", { length: 255 }).notNull(),
  lastName: varchar("last_name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  companyName: varchar("company_name", { length: 255 }),
  publicEncryptionKey: text("public_encryption_key").notNull(),
  // stored encrypted in db and decrypted in the front end using the account salt + user signature
  encryptedPrivateEncryptionKey: text(
    "encrypted_private_encryption_key"
  ).notNull(),
  companyAddress: varchar("company_address", { length: 255 }),
  isInstaller: boolean("is_installer").notNull().default(false), // for easier access
  installerId: text("installer_id"),
  contactType: contactTypesEnum("contact_type"),
  contactValue: varchar("contact_value", { length: 255 }),
});
export type UserType = InferSelectModel<typeof users>;
export type UserInsertType = typeof users.$inferInsert;
export type UserUpdateType = Partial<
  Pick<UserInsertType, "firstName" | "lastName" | "email" | "installerId">
>;

export const usersRelations = relations(users, ({ many, one }) => ({
  farms: many(farms),
  wallet: one(wallets, {
    fields: [users.id],
    references: [wallets.id],
  }),
  installer: one(installers, {
    fields: [users.installerId],
    references: [installers.id],
  }),
  applications: many(applications),
}));

/**
 * @dev Represents a Green Certificate Authority (GCA) in the system.
 * @param {string} id - The ethereum wallet address.
 * @param {string} email - The email of the GCA.
 * @param {timestamp} created_at - The creation date of the GCA.
 * @param {string} publicEncryptionKey - The public encryption key of the GCA.
 * @param {string} encryptedPrivateEncryptionKey - The encrypted private encryption key of the GCA.
 * @param {string} salt - The salt used for encryption.
 * @param {string[]} serverUrls - The server URLs associated with the GCA.
 */
export const Gcas = pgTable("gcas", {
  id: varchar("wallet", { length: 42 })
    .primaryKey()
    .notNull()
    .references(() => Accounts.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 255 }).unique().notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  publicEncryptionKey: text("public_encryption_key").notNull(),
  // stored encrypted in db and decrypted in the front end using the salt + user signature
  encryptedPrivateEncryptionKey: text(
    "encrypted_private_encryption_key"
  ).notNull(),
  serverUrls: varchar("server_urls", { length: 255 }).array().notNull(),
});

export type GcaType = InferSelectModel<typeof Gcas>;

export const GcasRelations = relations(Gcas, ({ many, one }) => ({
  account: one(Accounts, {
    fields: [Gcas.id],
    references: [Accounts.id],
  }),
  farms: many(farms),
  wallet: one(wallets, {
    fields: [Gcas.id],
    references: [wallets.id],
  }),
  applications: many(applications),
  applicationStepApprovals: many(ApplicationStepApprovals),
}));

/**
 * @dev Represents an application in the system.
 * @param {string} id - The unique ID of the application.
 * @param {string} userId - The ID of the user who submitted the application.
 * @param {string} farmId - The ID of the farm created after the application is completed.
 * @param {timestamp} created_at - The creation date of the application.
 * @param {number} currentStep - The current step of the application process.
 * @param {string} roundRobinStatus - The round robin status of the application.
 * @param {string} status - The status of the application.
 * @param {string} address - The address related to the application.
 * @param {number} lat - The latitude of the location.
 * @param {number} lng - The longitude of the location.
 * @param {number} establishedCostOfPowerPerKWh - The established cost of power per kWh.
 * @param {number} estimatedKWhGeneratedPerYear - The estimated kWh generated per year.
 * @param {timestamp} updatedAt - The last updated date of the application.
 * @param {string} finalQuotePerWatt - The final quote per watt for installation.
 * @param {timestamp} preInstallVisitDateFrom - The start date of the pre-install visit.
 * @param {timestamp} preInstallVisitDateTo - The end date of the pre-install visit.
 * @param {timestamp} installDate - The approximative installation date.
 * @param {timestamp} afterInstallVisitDateFrom - The start date of the post-install visit.
 * @param {timestamp} afterInstallVisitDateTo - The end date of the post-install visit.
 * @param {string} finalProtocolFee - The final protocol fee.
 * @param {timestamp} paymentDate - The payment date.
 * @param {string} paymentTxHash - The transaction hash of the payment.
 * @param {timestamp} gcaAssignedTimestamp - The timestamp when the GCA was assigned.
 * @param {timestamp} gcaAcceptanceTimestamp - The timestamp when the GCA accepted the assignment.
 * @param {string} gcaAddress - The address of the GCA.
 */
export const applications = pgTable("applications", {
  id: text("application_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  // always linked to a farm owner account
  userId: varchar("user_id", { length: 42 }).notNull(),
  // after application is "completed", a farm is created using the hexlified farm pub key
  farmId: varchar("farm_id", { length: 66 }).unique(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  currentStep: integer("current_step").notNull(),
  roundRobinStatus: roundRobinStatusEnum("round_robin_status").notNull(),
  status: applicationStatusEnum("application_status").notNull(),
  // enquiry step fields
  address: varchar("address", { length: 255 }).notNull(),
  lat: numeric("lat", {
    precision: 10,
    scale: 5,
  }).notNull(),
  lng: numeric("lng", {
    precision: 10,
    scale: 5,
  }).notNull(),
  establishedCostOfPowerPerKWh: numeric("established_cost_of_power_per_kwh", {
    precision: 10,
    scale: 2,
  }).notNull(),
  estimatedKWhGeneratedPerYear: numeric("estimated_kwh_generated_per_year", {
    precision: 10,
    scale: 2,
  }).notNull(),
  enquiryEstimatedFees: numeric("enquiry_estimated_fees", {
    precision: 10,
    scale: 2,
  }).notNull(),
  installerName: varchar("installer_name", { length: 255 }),
  installerCompanyName: varchar("installer_company_name", { length: 255 }),
  installerEmail: varchar("installer_email", { length: 255 }),
  installerPhone: varchar("installer_phone", { length: 255 }),
  // null if application just got created
  updatedAt: timestamp("updatedAt"),
  // pre-install documents step fields
  finalQuotePerWatt: varchar("final_quote_per_watt", { length: 255 }),
  // permit-documentation step fields
  preInstallVisitDateFrom: timestamp("pre_install_visit_date_from"),
  preInstallVisitDateTo: timestamp("pre_install_visit_date_to"),
  // approximative installation date provided by the installer / farm owner
  installDate: timestamp("install_date"),
  // inspection-pto step fields
  afterInstallVisitDateFrom: timestamp("after_install_visit_date_from"),
  afterInstallVisitDateTo: timestamp("after_install_visit_date_to"),
  finalProtocolFee: varchar("final_protocol_fee", { length: 255 }),
  intallFinishedDate: timestamp("install_finished_date"),
  // payment step fields
  paymentDate: timestamp("payment_date"),
  paymentTxHash: varchar("payment_tx_hash", { length: 66 }),
  // gca assignement fields
  gcaAssignedTimestamp: timestamp("gca_assigned_timestamp"),
  gcaAcceptanceTimestamp: timestamp("gca_acceptance_timestamp"),
  gcaAddress: varchar("gca_address", { length: 42 }),
  gcaAcceptanceSignature: varchar("gca_acceptance_signature", { length: 255 }),
});

export type ApplicationType = InferSelectModel<typeof applications>;
export type ApplicationInsertType = typeof applications.$inferInsert;
export type ApplicationUpdateEnquiryType = Pick<
  ApplicationInsertType,
  | "address"
  | "lat"
  | "lng"
  | "establishedCostOfPowerPerKWh"
  | "estimatedKWhGeneratedPerYear"
  | "enquiryEstimatedFees"
>;

export const applicationsRelations = relations(
  applications,
  ({ one, many }) => ({
    user: one(users, {
      fields: [applications.userId],
      references: [users.id],
    }),
    farm: one(farms, {
      fields: [applications.farmId],
      references: [farms.id],
    }),
    documentsMissingWithReason: many(DocumentsMissingWithReason),
    applicationStepApprovals: many(ApplicationStepApprovals),
    rewardSplits: many(RewardSplits),
    documents: many(Documents),
    deferments: many(deferments),
    gca: one(Gcas, {
      fields: [applications.gcaAddress],
      references: [Gcas.id],
    }),
  })
);

/**
 * @dev Represents an installer in the system.
 * @param {string} id - The unique ID of the installer.
 * @param {string} userId - The ID of the user associated with the installer.
 * @param {string} name - The name of the installer.
 * @param {string} email - The email of the installer.
 * @param {string} companyName - The company name of the installer.
 * @param {string} phone - The phone number of the installer.
 */
export const installers = pgTable("installers", {
  id: text("installer_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  companyName: varchar("company_name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 255 }).notNull(),
});

export type InstallerType = InferSelectModel<typeof installers>;
export type InstallerInsertType = typeof installers.$inferInsert;
export type InstallerUpdateType = Partial<
  Pick<InstallerInsertType, "name" | "email" | "companyName" | "phone">
>;

export const InstallersRelations = relations(installers, ({ one, many }) => ({
  user: one(users, {
    fields: [installers.id],
    references: [users.installerId],
  }),
}));

/**
 * @dev Represents a deferment in the system.
 * @param {string} id - The unique ID of the deferment.
 * @param {string} applicationId - The ID of the application associated with the deferment.
 * @param {string} reason - The reason for the deferment.
 * @param {string} fromGca - The ID of the GCA initiating the deferment.
 * @param {string} toGca - The ID of the GCA receiving the deferment.
 * @param {timestamp} timestamp - The timestamp when the deferment was created.
 */
export const deferments = pgTable("deferments", {
  id: text("deferment_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  applicationId: text("application_id")
    .notNull()
    .references(() => applications.id, { onDelete: "cascade" }),
  reason: varchar("reason", { length: 255 }),
  fromGca: varchar("from_gca", { length: 42 }).notNull(),
  toGca: varchar("to_gca", { length: 42 }).notNull(),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  defermentSignature: varchar("deferment_signature", { length: 255 }),
});

export type DefermentType = InferSelectModel<typeof deferments>;

export const DefermentsRelations = relations(deferments, ({ one }) => ({
  application: one(applications, {
    fields: [deferments.applicationId],
    references: [applications.id],
  }),
  fromGca: one(Gcas, {
    fields: [deferments.fromGca],
    references: [Gcas.id],
  }),
  toGca: one(Gcas, {
    fields: [deferments.toGca],
    references: [Gcas.id],
  }),
}));

/**
 * @dev Represents a document in the system.
 * @param {string} id - The unique ID of the document.
 * @param {string} applicationId - The ID of the application associated with the document.
 * @param {string} annotation - An annotation for the document.
 * @param {number} step - The step of the application process the document belongs to.
 * @param {string} name - The name of the document.
 * @param {string} url - The URL of the document.
 * @param {string} type - The type of the document.
 * @param {EncryptedMasterKeySet[]} encryptedMasterKeys - The encrypted master keys for the document.
 */
export const Documents = pgTable("documents", {
  id: text("document_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  applicationId: text("application_id").notNull(),
  annotation: varchar("annotation", { length: 255 }),
  step: integer("step").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  url: varchar("url", { length: 255 }).notNull(), // bytes of the encrypted document are stored on r2
  type: varchar("type", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  encryptedMasterKeys: json("encrypted_master_keys")
    .$type<EncryptedMasterKeySet>()
    .notNull()
    .array()
    .notNull(),
});

export type DocumentsType = InferSelectModel<typeof Documents>;
export type DocumentsInsertType = typeof Documents.$inferInsert;

export const DocumentsRelations = relations(Documents, ({ one }) => ({
  application: one(applications, {
    fields: [Documents.applicationId],
    references: [applications.id],
  }),
}));

/**
 * @dev Represents a missing document with a reason in the system.
 * @param {string} id - The unique ID of the missing document with reason.
 * @param {string} applicationId - The ID of the application associated with the missing document.
 * @param {string} reason - The reason for the missing document.
 * @param {number} step - The step of the application process the missing document belongs to.
 * @param {string} documentName - The name of the missing document.
 */
// if one of the optional documents is missing, we need to know why
export const DocumentsMissingWithReason = pgTable(
  "documentsMissingWithReason",
  {
    id: text("document_missing_with_reason_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    applicationId: text("application_id").notNull(),
    reason: varchar("reason", { length: 255 }).notNull(),
    step: integer("step").notNull(),
    documentName: optionalDocumentsEnum("document_name").notNull(),
  }
);

export type DocumentsMissingWithReasonType = InferSelectModel<
  typeof DocumentsMissingWithReason
>;
export type DocumentsMissingWithReasonInsertType =
  typeof DocumentsMissingWithReason.$inferInsert;

export const DocumentsMissingWithReasonRelations = relations(
  DocumentsMissingWithReason,
  ({ one }) => ({
    application: one(applications, {
      fields: [DocumentsMissingWithReason.applicationId],
      references: [applications.id],
    }),
  })
);

/**
 * @dev Represents the reward splits for USDG and GLOW.
 * @param {string} id - The unique ID of the reward split.
 * @param {string} applicationId - The ID of the application associated with the reward split.
 * @param {string} farmId - The ID of the farm, can be null if the application is not yet completed.
 * @param {string} walletAddress - The wallet address to receive the rewards.
 * @param {number} glowSplitPercent - The percentage split of Glow rewards.
 * @param {number} usdgSplitPercent - The percentage split of USDG rewards.
 */
// Reward Splits for USDG and GLOW add up to 100% for each token
export const RewardSplits = pgTable("rewardsSplits", {
  id: text("rewards_split_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  applicationId: text("application_id").notNull(),
  // farmId can be null if the application is not yet completed, it's being patched after the farm is created.
  farmId: varchar("farm_id", { length: 66 }),
  walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
  glowSplitPercent: numeric("glow_split_percent", {
    precision: 5,
    scale: 2,
  }).notNull(),
  usdgSplitPercent: numeric("usdg_split_percent", {
    precision: 5,
    scale: 2,
  }).notNull(),
});

export type RewardSplitsType = InferSelectModel<typeof RewardSplits>;

export const RewardSplitsRelations = relations(RewardSplits, ({ one }) => ({
  application: one(applications, {
    fields: [RewardSplits.applicationId],
    references: [applications.id],
  }),
  farm: one(farms, {
    fields: [RewardSplits.farmId],
    references: [farms.id],
  }),
}));

/**
 * @dev Represents a device associated with a farm.
 * @param {string} id - The unique ID of the device.
 * @param {string} farmId - The ID of the farm associated with the device.
 * @param {string} publicKey - The public key of the device.
 * @param {number} shortId - A short ID for simplicity and readability.
 */
export const Devices = pgTable("devices", {
  id: text("device_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  farmId: varchar("farm_id", { length: 66 })
    .notNull()
    .references(() => farms.id, { onDelete: "cascade" }),
  publicKey: varchar("public_key", { length: 255 }).unique().notNull(),
  shortId: integer("short_id").notNull(),
});

export type DeviceType = InferSelectModel<typeof Devices>;

export const DevicesRelations = relations(Devices, ({ one }) => ({
  farm: one(farms, {
    fields: [Devices.farmId],
    references: [farms.id],
  }),
}));

/**
 * @dev Represents an application step approval with an optional annotation.
 * @param {string} id - The unique ID of the approval.
 * @param {string} applicationId - The ID of the application associated with the approval.
 * @param {timestamp} approvedAt - The date and time when the application was approved.
 * @param {string} gcaAddress - The wallet address of the gca who approved the application.
 */
export const ApplicationStepApprovals = pgTable("applicationStepApprovals", {
  id: text("application_step_approval_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  applicationId: varchar("application_id", { length: 66 })
    .notNull()
    .references(() => applications.id, { onDelete: "cascade" }),
  approvedAt: timestamp("approved_at").notNull().defaultNow(),
  gcaAddress: varchar("gca_address", { length: 42 }).notNull(),
  signature: varchar("signature", { length: 255 }).notNull(),
  annotation: varchar("annotation", { length: 255 }), // optional annotation
  step: integer("step").notNull(),
});

export type ApplicationStepApprovalsType = InferSelectModel<
  typeof ApplicationStepApprovals
>;

export type ApplicationStepApprovalsInsertType =
  typeof ApplicationStepApprovals.$inferInsert;

export const ApplicationStepApprovalsRelations = relations(
  ApplicationStepApprovals,
  ({ one }) => ({
    application: one(applications, {
      fields: [ApplicationStepApprovals.applicationId],
      references: [applications.id],
    }),
    gca: one(Gcas, {
      fields: [ApplicationStepApprovals.gcaAddress],
      references: [Gcas.id],
    }),
  })
);
