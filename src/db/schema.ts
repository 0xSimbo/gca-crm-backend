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
} from "drizzle-orm/pg-core";
import { relations, type InferSelectModel, sql } from "drizzle-orm";
import {
  contactTypes,
  optionalDocuments,
  stepStatus,
} from "../types/api-types/Application";

// UNKNOWN is a special role that is used when the user didn't yet filled the solar farm owner form or the GCA form
export const accountRoles = ["FARM_OWNER", "GCA", "ADMIN", "UNKNOWN"] as const;

export const accountRoleEnum = pgEnum("role", accountRoles);

export const contacTypesEnum = pgEnum("contact_types", contactTypes);

export const applicationStatusEnum = pgEnum("step_status", stepStatus);

export const optionalDocumentsEnum = pgEnum(
  "optional_documents",
  optionalDocuments
);

export const splitTokensEnum = pgEnum("split_tokens", [
  "USDG",
  "GLOW",
] as const);

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
 * @dev This is still a work in progress.
 * @dev We keep aggregate counters to avoid needing to calculate them on the fly.
 * @param {string} id - The ethereum wallet address of the user.
 * @param {BigInt} totalUSDGRewards - The total USDG rewards of the user in 2 Decimals
            - USDG/USDC is in 6 decimals, but for the database, we use 2 decimals
            - because of SQL's integer limit.
            - We could save strings, but we may want some calculations in the database at some point
            - Example: totalUSDGRewards * 100 is $1
 * @param {BigInt} totalGlowRewards - The total Glow rewards of the user.
            - Follows same logic as above. 2 Decimals
            - Even though Glow is 18 Decimals On-Chain
 */
export const users = pgTable("users", {
  id: varchar("wallet", { length: 42 }).primaryKey().notNull(),
  totalUSDGRewards: bigint("total_usdg_rewards", { mode: "bigint" })
    .default(sql`'0'::bigint`)
    .notNull(),
  totalGlowRewards: bigint("total_glow_rewards", { mode: "bigint" })
    .default(sql`'0'::bigint`)
    .notNull(),
});

/**
 * @dev Each user has an array of weekly rewards.s
 */
export const userRelations = relations(users, ({ many }) => ({
  weeklyRewards: many(userWeeklyReward),
}));

/**
 * @dev This is still a work in progress.
 * @param {string} userId - The ethereum wallet address of the user.
 * @param {number} weekNumber - The week number of the rewards
 * @param {BigInt} usdgWeight - The total USDG Rewards weight for the user that is published in the merkle root
 * @param {BigInt} glowWeight - The total Glow Rewards weight for the user that is published in the merkle root
 * @param {BigInt} usdgRewards - The total USDG rewards of the user in 2 Decimals
 * @param {BigInt} glowRewards  - The total Glow rewards of the user in 2 Decimals
 */
export const userWeeklyReward = pgTable(
  "user_weekly_rewards",
  {
    userId: varchar("wallet", { length: 42 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
      pk: primaryKey({ columns: [t.userId, t.weekNumber] }),
    };
  }
);

/**
 * @dev Each user weekly reward has a user.
 * @dev This is a one-to-many relationship.
 * @dev Each user can have multiple weekly rewards.
 * @dev Each weekly reward belongs to a single user.
 */
export const UserWeeklyRewardRelations = relations(
  userWeeklyReward,
  ({ one }) => ({
    user: one(users, {
      fields: [userWeeklyReward.userId],
      references: [users.id],
    }),
  })
);

export const Farms = pgTable(
  "farms",
  {
    id: varchar("farm_id", { length: 66 }).primaryKey().notNull(),
    shortId: integer("short_id").notNull(),
    totalGlowRewards: bigint("total_glow_rewards", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    totalUSDGRewards: bigint("total_usdg_rewards", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    //TODO: Add all the other stuff about audit complete date,
    /*
     * need to add farm owner
     * need to add splits between owners
     * need to add the GCA that is assigned to that farm.
     *  @JulienWebDeveloppeur , let's connect on this when we get a chance
     */
  },
  (t) => {
    return {
      shortIdIndex: index("short_id_ix").on(t.shortId),
    };
  }
);

export const FarmRelations = relations(Farms, ({ many }) => ({
  farmRewards: many(FarmRewards),
}));

export const FarmRewards = pgTable(
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

export const FarmRewardsRelations = relations(FarmRewards, ({ one }) => ({
  farm: one(Farms, {
    fields: [FarmRewards.hexlifiedFarmPubKey],
    references: [Farms.id],
  }),
}));

export type UserType = InferSelectModel<typeof users>;
export type UserWeeklyRewardType = InferSelectModel<typeof userWeeklyReward>;
export type FarmDatabaseType = InferSelectModel<typeof Farms>;
export type FarmDatabaseInsertType = typeof Farms.$inferInsert;

export type FarmRewardsDatabaseType = InferSelectModel<typeof FarmRewards>;

export const Accounts = pgTable("accounts", {
  id: varchar("wallet", { length: 42 }).primaryKey().notNull(),
  role: accountRoleEnum("role"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  siweNonce: varchar("nonce", { length: 64 }).notNull(),
});
export type AccountType = InferSelectModel<typeof Accounts>;

export const FarmOwners = pgTable("farmOwners", {
  id: varchar("wallet", { length: 42 })
    .primaryKey()
    .notNull()
    .references(() => Accounts.id, { onDelete: "cascade" }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  firstName: varchar("first_name", { length: 255 }).notNull(),
  lastName: varchar("last_name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  companyName: varchar("company_name", { length: 255 }),
  companyAddress: varchar("company_address", { length: 255 }),
});
export type FarmOwnerType = InferSelectModel<typeof FarmOwners>;

export const Gcas = pgTable("gcas", {
  id: varchar("wallet", { length: 42 })
    .primaryKey()
    .notNull()
    .references(() => Accounts.id, { onDelete: "cascade" }),
  email: varchar("email", { length: 255 }).unique().notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  publicEncryptionKey: text("public_encryption_key").notNull(),
  privateEncryptionKey: text("private_encription_key").notNull(),
  serverUrls: varchar("server_urls", { length: 255 }).array().notNull(),
});
export type GcaType = InferSelectModel<typeof Gcas>;

export const accountsRelations = relations(Accounts, ({ one }) => ({
  farmOwner: one(FarmOwners, {
    fields: [Accounts.id],
    references: [FarmOwners.id],
  }),
  gca: one(Gcas, {
    fields: [Accounts.id],
    references: [Gcas.id],
  }),
}));

// Applications
export const Applications = pgTable("applications", {
  id: varchar("application_id", { length: 66 }).primaryKey().notNull(),
  // always linked to a farm owner account
  farmOwnerId: varchar("farm_owner_id", { length: 42 }).notNull(),
  // always linked to an installer ? //TODO @0xSimbo waiting for david on this
  installerId: varchar("installer_id", { length: 66 }).notNull(),
  // after application is "completed", a farm is created using the hexlified farm pub key
  farmId: varchar("farm_id", { length: 66 }).unique(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  currentStep: integer("current_step").notNull(),
  currentStepStatus: applicationStatusEnum("step_status").notNull(),
  contactType: contacTypesEnum("contact_type").notNull(),
  contactValue: varchar("contact_value", { length: 255 }).notNull(),
  // enquiry step fields
  address: varchar("address", { length: 255 }).notNull(),
  lat: varchar("lat", { length: 255 }).notNull(),
  lng: varchar("lng", { length: 255 }).notNull(),
  establishedCostOfPowerPerKWh: varchar("established_cost_of_power_per_kwh", {
    length: 255,
  }).notNull(),
  estimatedKWhGeneratedPerYear: varchar("estimated_kwh_generated_per_year", {
    length: 255,
  }).notNull(),
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
  // payment step fields
  paymentDate: timestamp("payment_date"),
  paymentTxHash: varchar("payment_tx_hash", { length: 66 }),
});

export type ApplicationType = InferSelectModel<typeof Applications>;

export const Installers = pgTable("installers", {
  id: varchar("installer_id", { length: 66 }).primaryKey().notNull(),
  name: varchar("name", { length: 255 }).unique().notNull(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  companyName: varchar("company_name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 255 }).notNull(),
});

export type InstallerType = InferSelectModel<typeof Installers>;

// if one of the optional documents is missing, we need to know why
export const DocumentsMissingWithReason = pgTable(
  "documentsMissingWithReason",
  {
    id: varchar("document_missing_with_reason_id", { length: 66 })
      .primaryKey()
      .notNull(),
    applicationId: varchar("application_id", { length: 66 })
      .notNull()
      .references(() => Applications.id, { onDelete: "cascade" }),
    reason: varchar("reason", { length: 255 }).notNull(),
    step: integer("step").notNull(),
    documentName: optionalDocumentsEnum("document_name").notNull(),
  }
);

export type DocumentsMissingWithReasonType = InferSelectModel<
  typeof DocumentsMissingWithReason
>;

export const ApplicationStepAnnotations = pgTable(
  "applicationStepAnnotations",
  {
    id: varchar("application_step_annotation_id", { length: 66 })
      .primaryKey()
      .notNull(),
    applicationId: varchar("application_id", { length: 66 })
      .notNull()
      .references(() => Applications.id, { onDelete: "cascade" }),
    annotation: varchar("annotation", { length: 255 }).notNull(),
    step: integer("step").notNull(),
  }
);

export type ApplicationStepAnnotationsType = InferSelectModel<
  typeof ApplicationStepAnnotations
>;

// Reward Splits for USDG and GLOW add up to 100% for each token
export const RewardSplits = pgTable("rewardsSplits", {
  id: varchar("rewards_split_id", { length: 66 }).primaryKey().notNull(),
  applicationId: varchar("application_id", { length: 66 })
    .notNull()
    .references(() => Applications.id, { onDelete: "cascade" }),
  walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
  splitPercentage: varchar("split_percentage", { length: 255 }).notNull(),
  token: splitTokensEnum("token").notNull(),
});

export type RewardSplitsType = InferSelectModel<typeof RewardSplits>;

// 0xSimbo: I added this table to store the devices that are connected to the farm but I'm not sure about the content, do we also want to have a shortId for the devices?
export const Devices = pgTable("devices", {
  id: varchar("device_id", { length: 66 }).primaryKey().notNull(),
  farmId: varchar("farm_id", { length: 66 })
    .notNull()
    .references(() => Farms.id, { onDelete: "cascade" }),
  publicKeys: varchar("public_keys", { length: 255 }).array().notNull(),
  shortIds: integer("short_ids").array().notNull(),
  powerOutputs: varchar("power_outputs", { length: 255 }).array().notNull(),
  impactRates: varchar("impact_rates", { length: 255 }).array().notNull(),
  status: varchar("status", { length: 255 }).notNull(),
});

export const applicationsRelations = relations(
  Applications,
  ({ one, many }) => ({
    farmOwner: one(FarmOwners, {
      fields: [Applications.farmOwnerId],
      references: [FarmOwners.id],
    }),
    farm: one(Farms, {
      fields: [Applications.farmId],
      references: [Farms.id],
    }),
    installer: one(Installers, {
      fields: [Applications.installerId],
      references: [Installers.id],
    }),
    documentsMissingWithReason: many(DocumentsMissingWithReason),
    applicationStepAnnotations: many(ApplicationStepAnnotations),
    rewardSplits: many(RewardSplits),
  })
);
