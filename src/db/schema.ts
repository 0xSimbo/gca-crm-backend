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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations, type InferSelectModel, sql, or } from "drizzle-orm";
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
  rewardSplits: many(RewardSplits),
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

export const Organizations = pgTable(
  "organizations",
  {
    id: text("organization_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    ownerId: varchar("owner_id", { length: 42 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => {
    return {
      ownerIdIndex: index("owner_id_ix").on(t.ownerId),
    };
  }
);

export const OrganizationRelations = relations(
  Organizations,
  ({ one, many }) => ({
    owner: one(users, {
      fields: [Organizations.ownerId],
      references: [users.id],
    }),
    users: many(OrganizationUsers),
    roles: many(Roles),
  })
);

export type OrganizationType = InferSelectModel<typeof Organizations>;
export type OrganizationInsertType = typeof Organizations.$inferInsert;

export const OrganizationApplications = pgTable(
  "organization_applications",
  {
    id: text("organization_application_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => Organizations.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" })
      .unique(),
    orgUserId: text("organization_user_id")
      .notNull()
      .references(() => OrganizationUsers.id, { onDelete: "cascade" }),
  },
  (t) => {
    return {
      applicationIdIndex: uniqueIndex("application_id_ix").on(t.applicationId),
    };
  }
);

export const OrganizationApplicationRelations = relations(
  OrganizationApplications,
  ({ one }) => ({
    organization: one(Organizations, {
      fields: [OrganizationApplications.organizationId],
      references: [Organizations.id],
    }),
    application: one(applications, {
      fields: [OrganizationApplications.applicationId],
      references: [applications.id],
    }),
  })
);

export type OrganizationApplicationType = InferSelectModel<
  typeof OrganizationApplications
>;
export type OrganizationApplicationInsertType =
  typeof OrganizationApplications.$inferInsert;

export const OrganizationUsers = pgTable(
  "organization_users",
  {
    id: text("organization_user_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: varchar("user_id", { length: 42 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => Organizations.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => Roles.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at"),
    invitedAt: timestamp("invited_at").notNull(),
    signature: varchar("signature", { length: 255 }), // Signature of the user accepting the invitation
    isAccepted: boolean("is_accepted").notNull().default(false),
    hasDocumentsAccess: boolean("has_documents_access")
      .notNull()
      .default(false),
    isOwner: boolean("is_owner").notNull().default(false),
  },
  (t) => {
    return {
      userIdOrganizationIdRoleIdIndex: index(
        "user_id_organization_id_role_id_ix"
      ).on(t.userId, t.organizationId, t.roleId),
    };
  }
);

export const OrganizationUsersRelations = relations(
  OrganizationUsers,
  ({ one, many }) => ({
    user: one(users, {
      fields: [OrganizationUsers.userId],
      references: [users.id],
    }),
    organization: one(Organizations, {
      fields: [OrganizationUsers.organizationId],
      references: [Organizations.id],
    }),
    role: one(Roles, {
      fields: [OrganizationUsers.roleId],
      references: [Roles.id],
    }),
    applicationsEncryptedMasterKeys: many(ApplicationsEncryptedMasterKeys),
  })
);

export type OrganizationUserType = InferSelectModel<typeof OrganizationUsers>;
export type OrganizationUserInsertType = typeof OrganizationUsers.$inferInsert;

export const Permissions = pgTable("permissions", {
  id: text("permission_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: varchar("name", { length: 255 }).notNull(),
  key: varchar("key", { length: 255 }).notNull().unique(),
  description: text("description"),
});

export const PermissionRelations = relations(Permissions, ({ many }) => ({
  roles: many(RolePermissions),
}));

export type PermissionType = InferSelectModel<typeof Permissions>;
export type PermissionInsertType = typeof Permissions.$inferInsert;

export const Roles = pgTable(
  "roles",
  {
    id: text("role_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => Organizations.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    isReadOnly: boolean("is_read_only").notNull().default(false),
  },
  (t) => {
    return {
      organizationIdIndex: index("organization_id_ix").on(t.organizationId),
    };
  }
);

export const RoleRelations = relations(Roles, ({ one, many }) => ({
  organization: one(Organizations, {
    fields: [Roles.organizationId],
    references: [Organizations.id],
  }),
  rolePermissions: many(RolePermissions),
  users: many(OrganizationUsers),
}));

export type RoleType = InferSelectModel<typeof Roles>;
export type RoleInsertType = typeof Roles.$inferInsert;

export const RolePermissions = pgTable(
  "role_permissions",
  {
    id: text("role_permission_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    roleId: text("role_id")
      .notNull()
      .references(() => Roles.id, { onDelete: "cascade" }),
    permissionId: text("permission_id")
      .notNull()
      .references(() => Permissions.id, { onDelete: "cascade" }),
  },
  (t) => {
    return {
      roleIdPermissionIdIndex: index("role_id_permission_id_ix").on(
        t.roleId,
        t.permissionId
      ),
    };
  }
);

export const RolePermissionRelations = relations(
  RolePermissions,
  ({ one }) => ({
    role: one(Roles, {
      fields: [RolePermissions.roleId],
      references: [Roles.id],
    }),
    permission: one(Permissions, {
      fields: [RolePermissions.permissionId],
      references: [Permissions.id],
    }),
  })
);

export const GcaDelegatedUsers = pgTable(
  "gca_delegated_users",
  {
    id: text("gca_delegated_user_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: varchar("user_id", { length: 42 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" })
      .unique(),
    gcaId: text("gca_id")
      .notNull()
      .references(() => Gcas.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => {
    return {
      userIdIndex: index("user_id_ix").on(t.userId),
      gcaIdIndex: index("gca_id_ix").on(t.gcaId),
    };
  }
);

export const GcaDelegatedUsersRelations = relations(
  GcaDelegatedUsers,
  ({ one, many }) => ({
    user: one(users, {
      fields: [GcaDelegatedUsers.userId],
      references: [users.id],
    }),
    gca: one(Gcas, {
      fields: [GcaDelegatedUsers.gcaId],
      references: [Gcas.id],
    }),
    applicationsEncryptedMasterKeys: many(ApplicationsEncryptedMasterKeys),
  })
);

export type GcaDelegatedUsersType = InferSelectModel<typeof GcaDelegatedUsers>;
export type GcaDelegatedUsersInsertType = typeof GcaDelegatedUsers.$inferInsert;

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
    id: varchar("farm_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()), // later on will be pulled from gca server
    totalGlowRewards: bigint("total_glow_rewards", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    totalUSDGRewards: bigint("total_usdg_rewards", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    auditCompleteDate: timestamp("audit_complete_date").notNull(),
    protocolFee: bigint("final_protocol_fee", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
    protocolFeePaymentHash: varchar("protocol_fee_payment_hash", {
      length: 66,
    }).notNull(),
    gcaId: varchar("gca_id", { length: 42 }).notNull(),
    userId: varchar("user_id", { length: 42 }).notNull(),
    oldShortIds: varchar("old_short_ids", { length: 255 }).array(),
  },
  (t) => {
    return {
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
  devices: many(Devices),
  application: one(applications, {
    fields: [farms.id],
    references: [applications.farmId],
  }),
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
    updatedAt: timestamp("updated_at").notNull(),
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
  role: accountRoleEnum("role").notNull().default("UNKNOWN"),
  createdAt: timestamp("createdAt").notNull(),
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
  createdAt: timestamp("createdAt").notNull(),
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
  Pick<
    UserInsertType,
    | "firstName"
    | "lastName"
    | "email"
    | "installerId"
    | "companyAddress"
    | "companyName"
  >
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
  applicationsDraft: many(applicationsDraft),
  organizationUser: one(OrganizationUsers, {
    fields: [users.id],
    references: [OrganizationUsers.userId],
  }),
  gcaDelegatedUser: one(GcaDelegatedUsers, {
    fields: [users.id],
    references: [GcaDelegatedUsers.userId],
  }),
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
  createdAt: timestamp("createdAt").notNull(),
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
  delegatedUsers: many(GcaDelegatedUsers),
}));

export const applicationsDraft = pgTable("applicationsDraft", {
  id: text("application_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: varchar("user_id", { length: 42 }).notNull(),
  createdAt: timestamp("createdAt").notNull(),
});

export type ApplicationDraftType = InferSelectModel<typeof applicationsDraft>;
export type ApplicationDraftInsertType = typeof applicationsDraft.$inferInsert;

export const applicationsDraftRelations = relations(
  applicationsDraft,
  ({ one }) => ({
    user: one(users, {
      fields: [applicationsDraft.userId],
      references: [users.id],
    }),
    application: one(applications, {
      fields: [applicationsDraft.id],
      references: [applications.id],
    }),
  })
);

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
 * @param {number} estimatedCostOfPowerPerKWh - The estimated cost of power per kWh.
 * @param {number} estimatedKWhGeneratedPerYear - The estimated kWh generated per year.
 * @param {number} enquiryEstimatedQuotePerWatt - The estimated quote per watt for installation.
 * @param {timestamp} updatedAt - The last updated date of the application.
 * @param {string} finalQuotePerWatt - The final quote per watt for installation.
 * @param {number} revisedKwhGeneratedPerYear - The revised kWh generated per year.
 * @param {number} revisedEstimatedProtocolFees - The revised estimated protocol fees.
 * @param {timestamp} preInstallVisitDateF - The date of the pre-install visit.
 * @param {timestamp} estimatedInstallDate - The estimated installation date provided by the installer or farm owner.
 * @param {timestamp} afterInstallVisitDate - The date of the post-install visit.
 * @param {bigint} finalProtocolFee - The final protocol fee as bigint 6decimals.
 * @param {timestamp} paymentDate - The payment date.
 * @param {string} paymentTxHash - The transaction hash of the payment.
 * @param {timestamp} gcaAssignedTimestamp - The timestamp when the GCA was assigned.
 * @param {timestamp} gcaAcceptanceTimestamp - The timestamp when the GCA accepted the assignment.
 * @param {string} gcaAddress - The address of the GCA.
 */
export const applications = pgTable("applications", {
  id: text("application_id").primaryKey(),
  // always linked to a farm owner account
  userId: varchar("user_id", { length: 42 }).notNull(),
  // after application is "completed", a farm is created using the hexlified farm pub key
  farmId: varchar("farm_id", { length: 66 }).unique(),
  createdAt: timestamp("createdAt").notNull(),
  currentStep: integer("current_step").notNull(),
  roundRobinStatus: roundRobinStatusEnum("round_robin_status").notNull(),
  status: applicationStatusEnum("application_status").notNull(),
  isCancelled: boolean("is_cancelled").notNull().default(false),
  isDocumentsCorrupted: boolean("is_documents_corrupted")
    .notNull()
    .default(false),
  // enquiry step fields
  address: varchar("address", { length: 255 }).notNull(),
  farmOwnerName: varchar("farm_owner_name", { length: 255 })
    .notNull()
    .default("N/A"),
  lat: numeric("lat", {
    precision: 10,
    scale: 5,
  }).notNull(),
  lng: numeric("lng", {
    precision: 10,
    scale: 5,
  }).notNull(),
  estimatedCostOfPowerPerKWh: numeric("estimated_cost_of_power_per_kwh", {
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
  enquiryEstimatedQuotePerWatt: numeric("enquiry_estimated_quote_per_watt", {
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
  revisedKwhGeneratedPerYear: numeric("revised_kwh_generated_per_year", {
    precision: 10,
    scale: 2,
  }),
  revisedCostOfPowerPerKWh: numeric("revised_cost_of_power_per_kwh", {
    precision: 10,
    scale: 2,
  }),
  revisedEstimatedProtocolFees: numeric("revised_estimated_protocol_fees", {
    precision: 10,
    scale: 2,
  }),
  // permit-documentation step fields
  // --- estimated installation date provided by the installer / farm owner
  estimatedInstallDate: timestamp("estimated_install_date"),
  preInstallVisitDate: timestamp("pre_install_visit_date"),
  preInstallVisitDateConfirmedTimestamp: timestamp(
    "pre_install_visit_date_confirmed_timestamp"
  ),
  // inspection-pto step fields
  // --- final installation date provided by the installer / farm owner
  installFinishedDate: timestamp("install_finished_date"),
  afterInstallVisitDate: timestamp("after_install_visit_date"),
  afterInstallVisitDateConfirmedTimestamp: timestamp(
    "after_install_visit_date_confirmed_timestamp"
  ),
  finalProtocolFee: bigint("final_protocol_fee", { mode: "bigint" })
    .default(sql`'0'::bigint`)
    .notNull(),
  // payment step fields
  paymentDate: timestamp("payment_date"),
  paymentTxHash: varchar("payment_tx_hash", { length: 66 }),
  // audit specific fields
  solarPanelsQuantity: integer("solar_panels_quantity"),
  solarPanelsBrandAndModel: varchar("solar_panels_brand_and_model", {
    length: 255,
  }),
  solarPanelsWarranty: varchar("solar_panels_warranty", { length: 255 }),
  averageSunlightHoursPerDay: numeric("average_sunlight_hours_per_day", {
    precision: 10,
    scale: 2,
  }),
  adjustedWeeklyCarbonCredits: numeric("adjusted_weekly_carbon_credits", {
    precision: 10,
    scale: 2,
  }),
  weeklyTotalCarbonDebt: numeric("weekly_total_carbon_debt", {
    precision: 10,
    scale: 2,
  }),
  netCarbonCreditEarningWeekly: numeric("net_carbon_credit_earning_weekly", {
    precision: 10,
    scale: 2,
  }),
  ptoObtainedDate: timestamp("pto_date"),
  locationWithoutPII: varchar("location_without_pii", { length: 255 }),
  // gca assignement fields
  gcaAssignedTimestamp: timestamp("gca_assigned_timestamp"),
  gcaAcceptanceTimestamp: timestamp("gca_acceptance_timestamp"),
  gcaAddress: varchar("gca_address", { length: 42 }),
  gcaAcceptanceSignature: varchar("gca_acceptance_signature", { length: 255 }),
});

export type ApplicationType = Omit<
  InferSelectModel<typeof applications>,
  "finalProtocolFee"
> & {
  finalProtocolFee: string;
};
export type ApplicationInsertType = typeof applications.$inferInsert;
export type ApplicationUpdateEnquiryType = Pick<
  ApplicationInsertType,
  | "address"
  | "lat"
  | "lng"
  | "estimatedCostOfPowerPerKWh"
  | "estimatedKWhGeneratedPerYear"
  | "enquiryEstimatedFees"
  | "enquiryEstimatedQuotePerWatt"
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
    applicationDraft: one(applicationsDraft, {
      fields: [applications.id],
      references: [applicationsDraft.id],
    }),
    devices: many(Devices),
    organizationApplication: one(OrganizationApplications, {
      fields: [applications.id],
      references: [OrganizationApplications.applicationId],
    }),
    applicationsEncryptedMasterKeys: many(ApplicationsEncryptedMasterKeys),
  })
);

export const ApplicationsEncryptedMasterKeys = pgTable(
  "applications_encrypted_master_keys",
  {
    id: text("encrypted_master_key_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull(),
    encryptedMasterKey: text("encrypted_master_key").notNull(),
    applicationId: text("application_id")
      .references(() => applications.id, { onDelete: "cascade" })
      .notNull(),
    organizationApplicationId: text("organization_application_id").references(
      () => OrganizationApplications.id,
      { onDelete: "cascade" }
    ),
    organizationUserId: text("organization_user_id").references(
      () => OrganizationUsers.id,
      { onDelete: "cascade" }
    ),
    gcaDelegatedUserId: text("gca_delegated_user_id").references(
      () => GcaDelegatedUsers.id,
      { onDelete: "cascade" }
    ),
  }
);

export const ApplicationsEncryptedMasterKeyRelations = relations(
  ApplicationsEncryptedMasterKeys,
  ({ one }) => ({
    user: one(users, {
      fields: [ApplicationsEncryptedMasterKeys.userId],
      references: [users.id],
      relationName: "user",
    }),
    gca: one(Gcas, {
      fields: [ApplicationsEncryptedMasterKeys.userId],
      references: [Gcas.id],
      relationName: "user",
    }),
    application: one(applications, {
      fields: [ApplicationsEncryptedMasterKeys.applicationId],
      references: [applications.id],
    }),
    organizationUser: one(OrganizationUsers, {
      fields: [ApplicationsEncryptedMasterKeys.organizationUserId],
      references: [OrganizationUsers.id],
    }),
    gcaDelegatedUser: one(GcaDelegatedUsers, {
      fields: [ApplicationsEncryptedMasterKeys.gcaDelegatedUserId],
      references: [GcaDelegatedUsers.id],
    }),
    organizationApplication: one(OrganizationApplications, {
      fields: [ApplicationsEncryptedMasterKeys.organizationApplicationId],
      references: [OrganizationApplications.id],
    }),
  })
);

export type ApplicationsEncryptedMasterKeysType = InferSelectModel<
  typeof ApplicationsEncryptedMasterKeys
>;

export type ApplicationsEncryptedMasterKeysInsertType =
  typeof ApplicationsEncryptedMasterKeys.$inferInsert;

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
  timestamp: timestamp("timestamp").notNull(),
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
  annotation: text("annotation"),
  step: integer("step").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  url: varchar("url", { length: 255 }).notNull(), // bytes of the encrypted document are stored on r2
  type: varchar("type", { length: 255 }).notNull(), // extension of the document ( pdf, png, jpg, ...)
  isEncrypted: boolean("isEncrypted").notNull().default(false), // if true the document is stored on r2 with the ".enc" extension
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at"),
  encryptedMasterKeys: json("encrypted_master_keys")
    .$type<EncryptedMasterKeySet>()
    .array(),
  isOverWritten: boolean("over_written").notNull().default(false),
});

export type DocumentsType = InferSelectModel<typeof Documents>;
export type DocumentsInsertType = typeof Documents.$inferInsert;

export const DocumentsRelations = relations(Documents, ({ one, many }) => ({
  application: one(applications, {
    fields: [Documents.applicationId],
    references: [applications.id],
  }),
  updates: many(documentsUpdates),
}));

export const documentsUpdates = pgTable("documentsUpdates", {
  id: text("document_update_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  documentId: text("document_id").notNull(),
  updatedBy: varchar("updated_by", { length: 42 }).notNull(),
  createdAt: timestamp("created_at").notNull(),
});

export type DocumentsUpdatesType = InferSelectModel<typeof documentsUpdates>;
export type DocumentsUpdatesInsertType = typeof documentsUpdates.$inferInsert;

export const DocumentsUpdatesRelations = relations(
  documentsUpdates,
  ({ one }) => ({
    document: one(Documents, {
      fields: [documentsUpdates.documentId],
      references: [Documents.id],
    }),
    wallet: one(wallets, {
      fields: [documentsUpdates.updatedBy],
      references: [wallets.id],
    }),
  })
);

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
  applicationId: text("application_id"),
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
export type RewardSplitsInsertType = typeof RewardSplits.$inferInsert;

export const RewardSplitsRelations = relations(RewardSplits, ({ one }) => ({
  application: one(applications, {
    fields: [RewardSplits.applicationId],
    references: [applications.id],
  }),
  farm: one(farms, {
    fields: [RewardSplits.farmId],
    references: [farms.id],
  }),
  wallet: one(wallets, {
    fields: [RewardSplits.walletAddress],
    references: [wallets.id],
  }),
}));

/**
 * @dev Represents a device associated with a farm.
 * @param {string} id - The unique ID of the device.
 * @param {string} farmId - The ID of the farm associated with the device.
 * @param {string} publicKey - The public key of the device.
 * @param {number} shortId - A short ID for simplicity and readability.
 * @param {boolean} isEnabled - Indicates if the device is enabled.
 * @param {timestamp} enabledAt - The date and time when the device was enabled.
 * @param {timestamp} disabledAt - The date and time when the device was disabled.
 */
export const Devices = pgTable("devices", {
  id: text("device_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  farmId: varchar("farm_id", { length: 66 })
    .notNull()
    .references(() => farms.id, { onDelete: "cascade" }),
  publicKey: varchar("public_key", { length: 255 }).unique().notNull(),
  shortId: varchar("short_id", { length: 255 }).notNull(), // can have multiple devices with the same shortId but different public keys // @0xSimbo will store as varchar since it's planned to change it to an hex
  isEnabled: boolean("is_enabled").notNull().default(true),
  enabledAt: timestamp("enabled_at"),
  disabledAt: timestamp("disabled_at"),
});

export type DeviceType = InferSelectModel<typeof Devices>;
export type DeviceInsertType = typeof Devices.$inferInsert;

export const DevicesRelations = relations(Devices, ({ one }) => ({
  farm: one(farms, {
    fields: [Devices.farmId],
    references: [farms.id],
  }),
  application: one(applications, {
    fields: [Devices.farmId],
    references: [applications.farmId],
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
  approvedAt: timestamp("approved_at").notNull(),
  gcaAddress: varchar("gca_address", { length: 42 }).notNull(),
  signature: varchar("signature", { length: 255 }).notNull(),
  annotation: text("annotation"), // optional annotation extra thoughts
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
