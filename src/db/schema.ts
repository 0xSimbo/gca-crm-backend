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
  serial,
  doublePrecision,
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
import { z } from "zod";

// db diagram here : https://app.eraser.io/workspace/Ro75vSbOwABbdvKvyTFJ?origin=share @0xSimbo

export type FarmUpdate = {
  previousValue: any;
  updatedValue: any;
};

export type RewardsSplit = {
  walletAddress: string;
  usdgSplitPercent: string;
  glowSplitPercent: string;
};

/**
    * @dev
    Rewards in the database are stored in 2 decimals.
    Even though Glow is in 18 decimals on-chain, we store it in 2 decimals in the database.
    This is to fit SQL bigint limits.
    Example: 1 Glow = 100 in the database
    The same follows for USDG
    Example: 1 USDG = 100 in the database
    50|
    51|    While rewards are stored in 2 decimals, the `weights` are stored as raw values.
    52|    Weights are created by the GCAs in the weekly reports. We get these weights directly from
    53|    the merkletrees that the GCAs provide. Those are stored raw and have 6 decimals of precision
    54|    which should fit within the SQL bigint limits.
    55|    The max bigint value in SQL is 2**63 - 1 = 9223372036854775807
    56|    If GCAs provide weights with 6 decimals, that means that a single bucket would need more than
    57|    $9,223,372,036,854.775807 as a reward for a single solar farm. We're not there yet.
    58|
    59|*/

/**
 * @dev We keep aggregate counters to avoid needing to calculate them on the fly.
 * @param {string} id - The ethereum wallet address.
 * @param {BigInt} totalUSDGRewards - The total USDG rewards of the user in 2 Decimals
 *            - USDG/USDC is in 6 decimals, but for the database, we use 2 decimals
 *            - because of SQL's integer limit.
 *            - We could save strings, but we may want some calculations in the database at some point
 *            - Example: totalUSDGRewards * 100 is $1
 * @param {BigInt} totalGlowRewards - The total Glow rewards of the user.
 *            - Follows same logic as above. 2 Decimals
 *            - Even though Glow is 18 Decimals On-Chain
 * 72| */
export const wallets = pgTable("wallets", {
  id: varchar("wallet_id", { length: 42 }).primaryKey().notNull(),
  totalUSDGRewards: bigint("total_usdg_rewards", { mode: "bigint" })
    .default(sql`'0'::bigint`)
    .notNull(),
  totalGlowRewards: bigint("total_glow_rewards", { mode: "bigint" })
    .default(sql`'0'::bigint`)
    .notNull(),
  fractionNonce: integer("fraction_nonce").notNull().default(0), // Track nonce for fraction creation per wallet
});

/**
 * @dev Each wallets has an array of weekly rewards.
 */
export const WalletsRelations = relations(wallets, ({ many, one }) => ({
  weeklyRewards: many(walletWeeklyRewards),
  rewardSplits: many(RewardSplits),
  referralsAsReferrer: many(referrals, { relationName: "referrer" }),
  referralAsReferee: one(referrals, {
    fields: [wallets.id],
    references: [referrals.refereeWallet],
    relationName: "referee",
  }),
  referralCode: one(referralCodes, {
    fields: [wallets.id],
    references: [referralCodes.walletAddress],
  }),
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
    shareAllApplications: boolean("share_all_applications").default(false),
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
 * @param {BigInt} protocolFee - The protocol fee of the farm.
 * @param {string} protocolFeePaymentHash - The hash of the transaction that paid the protocol fee.
 * @param {string} protocolFeeAdditionalPaymentTxHash - Optional Additional payment hash for the protocol fee.
 * @param {string} gcaId - The GCA (Green Certificate Authority) ID.
 * @param {string} userId - The user ID who owns the farm.
 * @param {string} region - The region of the farm.
 * @param {string} regionFullName - The full name of the region.
 * @param {string} signalType - The signal type of the region.
 */
export const farms = pgTable(
  "farms",
  {
    id: varchar("farm_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    zoneId: integer("zone_id").notNull().default(1),
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
    protocolFeeAdditionalPaymentTxHash: varchar(
      "protocol_fee_additional_payment_tx_hash",
      {
        length: 66,
      }
    ),
    gcaId: varchar("gca_id", { length: 42 }).notNull(),
    userId: varchar("user_id", { length: 42 }).notNull(),
    oldShortIds: varchar("old_short_ids", { length: 255 }).array(),
    region: varchar("region", { length: 255 }).notNull().default("__UNSET__"),
    regionFullName: varchar("region_full_name", { length: 255 })
      .notNull()
      .default("__UNSET__"),
    signalType: varchar("signal_type", { length: 255 })
      .notNull()
      .default("__UNSET__"),
    name: varchar("name", { length: 255 }).notNull().default("__UNSET__"),
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
  zone: one(zones, {
    fields: [farms.zoneId],
    references: [zones.id],
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

export const deviceRewardParent = pgTable("device_reward_parent", {
  id: varchar("device_hexkey", { length: 66 }).primaryKey().notNull(),
});
export const deviceRewards = pgTable(
  "device_rewards",
  {
    hexlifiedFarmPubKey: varchar("device_pubkey", { length: 66 })
      .notNull()
      .references(() => deviceRewardParent.id, { onDelete: "cascade" }),
    weekNumber: integer("week_number").notNull(),
    usdgRewards: numeric("usdg_rewards", { precision: 30, scale: 2 }),
    glowRewards: numeric("glow_rewards", { precision: 30, scale: 2 }),
  },
  (t) => {
    return {
      weekNumberIndex: index("week_number_ix").on(t.weekNumber),
      weekHexPubkeyUniqueIndex: uniqueIndex("week_hex_pubkey_unique_ix").on(
        t.weekNumber,
        t.hexlifiedFarmPubKey
      ),
    };
  }
);

export const DeviceParentRelations = relations(
  deviceRewardParent,
  ({ many }) => ({
    deviceRewards: many(deviceRewards),
  })
);

export const DeviceRewardsRelations = relations(deviceRewards, ({ one }) => ({
  farm: one(deviceRewardParent, {
    fields: [deviceRewards.hexlifiedFarmPubKey],
    references: [deviceRewardParent.id],
  }),
}));

export type DeviceRewardsDatabaseType = InferSelectModel<typeof deviceRewards>;
export type DeviceRewardsInsertType = typeof deviceRewards.$inferInsert;

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
 * @dev Represents the common fields for all applications
 * @param {string} id - The unique ID of the application.
 * @param {string} userId - The ID of the user who submitted the application.
 * @param {string} farmId - The ID of the farm created after the application is completed.
 * @param {timestamp} created_at - The creation date of the application.
 * @param {number} currentStep - The current step of the application process.
 * @param {string} roundRobinStatus - The round robin status of the application.
 * @param {string} status - The status of the application.
 *
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
 * @param {string} additionalPaymentTxHash - The transaction hash of the additional payment if the payment was split into more than one tx
 * @param {timestamp} gcaAssignedTimestamp - The timestamp when the GCA was assigned.
 * @param {timestamp} gcaAcceptanceTimestamp - The timestamp when the GCA accepted the assignment.
 * @param {string} gcaAddress - The address of the GCA.
 */
export const applications = pgTable(
  "applications",
  {
    id: text("application_id").primaryKey(),
    userId: varchar("user_id", { length: 42 }).notNull(),
    zoneId: integer("zone_id").notNull().default(1),
    farmId: varchar("farm_id", { length: 66 })
      .unique()
      .references(() => farms.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").notNull(),
    currentStep: integer("current_step").notNull(),
    roundRobinStatus: roundRobinStatusEnum("round_robin_status").notNull(),
    status: applicationStatusEnum("application_status").notNull(),
    isCancelled: boolean("is_cancelled").notNull().default(false),
    isDocumentsCorrupted: boolean("is_documents_corrupted")
      .notNull()
      .default(false),
    // null if application just got created
    updatedAt: timestamp("updatedAt"),
    declarationOfIntentionSignature: varchar(
      "declaration_of_intention_signature",
      { length: 255 }
    ),
    declarationOfIntentionSignatureDate: timestamp(
      "declaration_of_intention_signature_date"
    ),
    declarationOfIntentionFieldsValue: json(
      "declaration_of_intention_fields_value"
    ),
    declarationOfIntentionCommitedOnChainTxHash: varchar(
      "declaration_of_intention_commited_on_chain_tx_hash",
      { length: 66 }
    ),
    declarationOfIntentionVersion: varchar("declaration_of_intention_version", {
      length: 12,
    }),
    auditFees: bigint("audit_fees", { mode: "bigint" }).default(
      sql`'0'::bigint`
    ),
    auditFeesTxHash: varchar("audit_fees_tx_hash", { length: 66 }),
    auditFeesPaymentDate: timestamp("audit_fees_payment_date"),
    // wallet signature of the account owner
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
    certifiedInstallerId: varchar("certified_installer_id", {
      length: 255,
    }).references(() => installers.id, { onDelete: "cascade" }),
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
    additionalPaymentTxHash: varchar("additional_payment_tx_hash", {
      length: 66,
    }),
    paymentAmount: numeric("payment_amount", {
      precision: 38,
      scale: 0,
    })
      .default(sql`'0'::numeric`)
      .notNull(),
    paymentCurrency: varchar("payment_currency", { length: 20 })
      .notNull()
      .default("USDG"), // USDG or GCTL or USDC or GLW or GCTL or SGCTL
    paymentEventType: varchar("payment_event_type", { length: 66 })
      .notNull()
      .default("PayProtocolFee"), // PayProtocolFee or PayProtocolFeeAndMintGCTLAndStake
    // gca assignement fields
    gcaAssignedTimestamp: timestamp("gca_assigned_timestamp"),
    gcaAcceptanceTimestamp: timestamp("gca_acceptance_timestamp"),
    gcaAddress: varchar("gca_address", { length: 42 }),
    gcaAcceptanceSignature: varchar("gca_acceptance_signature", {
      length: 255,
    }),
    // allowed zones for the application. 1 is zone CGP, 2 is zone UTAH, etc.
    allowedZones: integer("allowed_zones")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    // Maximum splits value in USDC (6 decimals) - can be overridden per application
    maxSplits: bigint("max_splits", { mode: "bigint" })
      .default(sql`'0'::bigint`)
      .notNull(),
  },
  (t) => ({
    // Performance indexes for GLW vault principal queries (critical for delegators leaderboard)
    statusIndex: index("applications_status_idx").on(t.status),
    paymentCurrencyIndex: index("applications_payment_currency_idx").on(
      t.paymentCurrency
    ),
    vaultLookupIndex: index("applications_vault_lookup_idx").on(
      t.farmId,
      t.isCancelled,
      t.status,
      t.paymentCurrency
    ),
  })
);

/**
 * @dev Fields for competitive recursive subsidy applications
 * @param {string} applicationId - The ID of the application
 * @param {string} address - The address of the farm
 * @param {string} farmOwnerName - The name of the farm owner
 * @param {string} farmOwnerEmail - The email of the farm owner
 * @param {string} farmOwnerPhone - The phone number of the farm owner
 * @param {number} lat - The latitude of the farm
 * @param {number} lng - The longitude of the farm
 * @param {number} estimatedCostOfPowerPerKWh - The estimated cost of power per kWh
 * @param {number} estimatedKWhGeneratedPerYear - The estimated kWh generated per year
 * @param {number} enquiryEstimatedFees - The estimated fees for the enquiry
 * @param {number} enquiryEstimatedQuotePerWatt - The estimated quote per watt for installation
 * @param {string} installerName - The name of the installer
 * @param {string} installerCompanyName - The company name of the installer
 * @param {string} installerEmail - The email of the installer
 * @param {string} installerPhone - The phone number of the installer
 */
export const applicationsEnquiryFieldsCRS = pgTable(
  "applications_enquiry_fields_crs",
  {
    id: text("enquiry_field_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    address: varchar("address", { length: 255 }).notNull(),
    farmOwnerName: varchar("farm_owner_name", { length: 255 }).notNull(),
    farmOwnerEmail: varchar("farm_owner_email", { length: 255 }).notNull(),
    farmOwnerPhone: varchar("farm_owner_phone", { length: 255 }).notNull(),
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
      scale: 5,
    }).notNull(),
    estimatedKWhGeneratedPerYear: numeric("estimated_kwh_generated_per_year", {
      precision: 15,
      scale: 5,
    }).notNull(),
    enquiryEstimatedFees: numeric("enquiry_estimated_fees", {
      precision: 15,
      scale: 5,
    }).notNull(),
    enquiryEstimatedQuotePerWatt: numeric("enquiry_estimated_quote_per_watt", {
      precision: 10,
      scale: 5,
    }).notNull(),
    estimatedAdjustedWeeklyCredits: numeric(
      "estimated_adjusted_weekly_credits",
      {
        precision: 10,
        scale: 5,
      }
    )
      .notNull()
      .default(sql`'0'::numeric`),
    installerName: varchar("installer_name", { length: 255 }),
    installerCompanyName: varchar("installer_company_name", {
      length: 255,
    }),
    installerEmail: varchar("installer_email", { length: 255 }),
    installerPhone: varchar("installer_phone", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at"),
  },
  (t) => ({
    enquiry_application_id_unique_ix: uniqueIndex(
      "enquiry_application_id_unique_ix"
    ).on(t.applicationId),
  })
);

export type ApplicationEnquiryFieldsCRSInsertType =
  typeof applicationsEnquiryFieldsCRS.$inferInsert;

/**
 * @dev Fields for competitive recursive subsidy applications
 * @param {string} applicationId - The ID of the application
 * @param {string} solarPanelsQuantity - The quantity of solar panels
 * @param {string} solarPanelsBrandAndModel - The brand and model of the solar panels
 * @param {string} solarPanelsWarranty - The warranty of the solar panels
 * @param {string} averageSunlightHoursPerDay - The average sunlight hours per day
 * @param {string} adjustedWeeklyCarbonCredits - The adjusted weekly carbon credits
 * @param {string} weeklyTotalCarbonDebt - The weekly total carbon debt
 * @param {string} netCarbonCreditEarningWeekly - The net carbon credit earning weekly
 * @param {string} finalEnergyCost - The final energy cost
 * @param {string} systemWattageOutput - The system wattage output
 * @param {string} ptoObtainedDate - The PTO obtained date
 * @param {string} locationWithoutPII - The location without PII
 * @param {string} revisedInstallFinishedDate - The revised install finished date
 */
export const applicationsAuditFieldsCRS = pgTable(
  "applications_audit_fields_crs",
  {
    id: text("audit_field_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    averageSunlightHoursPerDay: numeric("average_sunlight_hours_per_day", {
      precision: 10,
      scale: 5,
    }).notNull(),
    adjustedWeeklyCarbonCredits: numeric("adjusted_weekly_carbon_credits", {
      precision: 10,
      scale: 6,
    }).notNull(),
    weeklyTotalCarbonDebt: numeric("weekly_total_carbon_debt", {
      precision: 10,
      scale: 5,
    }).notNull(),
    netCarbonCreditEarningWeekly: numeric("net_carbon_credit_earning_weekly", {
      precision: 10,
      scale: 5,
    }).notNull(),
    solarPanelsQuantity: integer("solar_panels_quantity"),
    solarPanelsBrandAndModel: varchar("solar_panels_brand_and_model", {
      length: 255,
    }),
    solarPanelsWarranty: varchar("solar_panels_warranty", { length: 255 }),
    finalEnergyCost: numeric("final_energy_cost", {
      precision: 10,
      scale: 5,
    }),
    systemWattageOutput: varchar("system_wattage_output", { length: 255 }),
    ptoObtainedDate: timestamp("pto_date"),
    locationWithoutPII: varchar("location_without_pii", { length: 255 }),
    revisedInstallFinishedDate: timestamp("revised_install_finished_date"),
    devices: json("devices").$type<{ publicKey: string; shortId: string }[]>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at"),
  },
  (t) => ({
    audit_application_id_unique_ix: uniqueIndex(
      "audit_application_id_unique_ix"
    ).on(t.applicationId),
  })
);

export type ApplicationAuditFieldsCRSInsertType =
  typeof applicationsAuditFieldsCRS.$inferInsert;

export const ApplicationsEnquiryFieldsCRSRelations = relations(
  applicationsEnquiryFieldsCRS,
  ({ one }) => ({
    application: one(applications, {
      fields: [applicationsEnquiryFieldsCRS.applicationId],
      references: [applications.id],
    }),
  })
);

export const ApplicationsAuditFieldsCRSRelations = relations(
  applicationsAuditFieldsCRS,
  ({ one }) => ({
    application: one(applications, {
      fields: [applicationsAuditFieldsCRS.applicationId],
      references: [applications.id],
    }),
  })
);

export type ApplicationType = Omit<
  InferSelectModel<typeof applications>,
  "finalProtocolFee" | "auditFees" | "maxSplits"
> & {
  finalProtocolFee: string;
  finalProtocolFeeBigInt: string;
  enquiryFields: ApplicationEnquiryFieldsCRSInsertType | null;
  auditFields: ApplicationAuditFieldsCRSInsertType | null;
  auditFees: string;
  maxSplits: string;
};
export type ApplicationInsertType = typeof applications.$inferInsert;
export type ApplicationUpdateEnquiryType = Pick<
  ApplicationEnquiryFieldsCRSInsertType,
  | "address"
  | "lat"
  | "lng"
  | "estimatedCostOfPowerPerKWh"
  | "estimatedKWhGeneratedPerYear"
  | "enquiryEstimatedFees"
  | "enquiryEstimatedQuotePerWatt"
  | "estimatedAdjustedWeeklyCredits"
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
    zone: one(zones, {
      fields: [applications.zoneId],
      references: [zones.id],
    }),
    enquiryFieldsCRS: one(applicationsEnquiryFieldsCRS, {
      fields: [applications.id],
      references: [applicationsEnquiryFieldsCRS.applicationId],
    }),
    auditFieldsCRS: one(applicationsAuditFieldsCRS, {
      fields: [applications.id],
      references: [applicationsAuditFieldsCRS.applicationId],
    }),
    applicationPriceQuotes: many(ApplicationPriceQuotes),
    installer: one(installers, {
      fields: [applications.certifiedInstallerId],
      references: [installers.id],
    }),
    fractions: many(fractions),
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
  isCertified: boolean("is_certified").notNull().default(false),
  zoneIds: text("zone_ids")
    .array()
    .notNull()
    .default(sql`'{}'::integer[]`),
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
  isShowingSolarPanels: boolean("is_showing_solar_panels")
    .notNull()
    .default(false),
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
export const RewardSplits = pgTable(
  "rewardsSplits",
  {
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
    updatedAt: timestamp("updated_at"),
  },
  (t) => ({
    // Performance indexes for wallet and farm reward lookups
    walletAddressIndex: index("rewards_splits_wallet_address_idx").on(
      t.walletAddress
    ),
    farmIdIndex: index("rewards_splits_farm_id_idx").on(t.farmId),
    applicationIdIndex: index("rewards_splits_application_id_idx").on(
      t.applicationId
    ),
  })
);

export const RewardsSplitsHistory = pgTable("rewardsSplitsHistory", {
  id: text("rewards_splits_history_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  applicationId: text("application_id").notNull(),
  farmId: varchar("farm_id", { length: 66 }).notNull(),
  rewardsSplits: json("rewards_splits").$type<RewardsSplit[]>().notNull(),
  createdAt: timestamp("created_at").notNull(),
  overWrittenBy: varchar("over_written_by", { length: 42 }).notNull(),
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

export const RewardsSplitsHistoryRelations = relations(
  RewardsSplitsHistory,
  ({ one }) => ({
    application: one(applications, {
      fields: [RewardsSplitsHistory.applicationId],
      references: [applications.id],
    }),
    farm: one(farms, {
      fields: [RewardsSplitsHistory.farmId],
      references: [farms.id],
    }),
  })
);

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
  previousPublicKey: varchar("previous_public_key", { length: 255 }), // if device is a replacement, store the previous public key
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

/**
 * @dev Tracks GCA-issued price-per-asset quotes at audit completion.
 *      Stored as strings representing integer amounts with 6 decimals.
 *      (USD/USDC/USDG/GCTL).
 */
export const ApplicationPriceQuotes = pgTable("application_price_quotes", {
  id: text("application_price_quote_id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  applicationId: text("application_id")
    .notNull()
    .references(() => applications.id, { onDelete: "cascade" }),
  gcaAddress: varchar("gca_address", { length: 42 }).notNull(),
  prices: json("prices").$type<Record<string, string>>().notNull(),
  typesVersion: varchar("types_version", { length: 16 })
    .notNull()
    .default("v1"),
  signature: varchar("signature", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ApplicationPriceQuoteType = InferSelectModel<
  typeof ApplicationPriceQuotes
>;
export type ApplicationPriceQuoteInsertType =
  typeof ApplicationPriceQuotes.$inferInsert;

export const ApplicationPriceQuotesRelations = relations(
  ApplicationPriceQuotes,
  ({ one }) => ({
    application: one(applications, {
      fields: [ApplicationPriceQuotes.applicationId],
      references: [applications.id],
    }),
  })
);

export const DeclarationOfIntentionMerkleRoots = pgTable(
  "declaration_of_intention_merkle_roots",
  {
    id: text("declaration_of_intention_merkle_roots_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    timestamp: timestamp("timestamp").notNull(),
    merkleRoot: varchar("merkle_root", { length: 66 }).notNull(),
    txHash: varchar("tx_hash", { length: 66 }).notNull(),
    merkleRootLength: integer("merkle_root_length").notNull(),
    applicationIds: text("application_ids").array().notNull(),
    r2Url: varchar("r2_url", { length: 255 }).notNull(),
  }
);

// ---------- Zones & dynamic-requirements (v2) ----------
export const requirementSets = pgTable("requirement_sets", {
  id: serial("requirement_set_id").primaryKey(),
  code: varchar("code", { length: 32 }).notNull().unique(), // e.g. 'CRS'
  name: varchar("name", { length: 255 }).notNull(), // friendly label
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type RequirementSetType = InferSelectModel<typeof requirementSets>;
export type RequirementSetInsert = typeof requirementSets.$inferInsert;

/**
 * @dev Represents a zone in the system.
 * @param {string} id - The unique ID of the zone.
 * @param {string} name - The name of the zone.
 * @param {number} requirementSetId - The ID of the requirement set associated with the zone.
 * @param {timestamp} createdAt - The date and time when the zone was created.
 * @param {boolean} isActive - Whether the zone is active.
 */
export const zones = pgTable("zones", {
  id: serial("zone_id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  requirementSetId: integer("requirement_set_id")
    .notNull()
    .references(() => requirementSets.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(false),
  isAcceptingSponsors: boolean("is_accepting_sponsors")
    .notNull()
    .default(false),
});

export const ZoneRelations = relations(zones, ({ one, many }) => ({
  requirementSet: one(requirementSets, {
    fields: [zones.requirementSetId],
    references: [requirementSets.id],
  }),
  applications: many(applications),
  farms: many(farms),
}));

export type ZoneType = InferSelectModel<typeof zones>;
export type ZoneInsert = typeof zones.$inferInsert;

// ---------- end zones ----------

/**
 * @dev Represents default maxSplits configuration that applies to all applications
 * @param {number} id - The unique ID of the default configuration
 * @param {BigInt} maxSplits - The default maximum splits value in USDC (6 decimals)
 * @param {timestamp} createdAt - When this default was set
 * @param {timestamp} updatedAt - When this default was last updated
 * @param {string} updatedBy - The wallet address of who updated this default
 * @param {boolean} isActive - Whether this default is currently active
 */
export const defaultMaxSplits = pgTable("default_max_splits", {
  id: serial("default_max_splits_id").primaryKey(),
  maxSplits: bigint("max_splits", { mode: "bigint" })
    .default(sql`'0'::bigint`)
    .notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

export type DefaultMaxSplitsType = InferSelectModel<typeof defaultMaxSplits>;
export type DefaultMaxSplitsInsertType = typeof defaultMaxSplits.$inferInsert;

/**
 * @dev Represents fraction sales created from applications
 * @param {string} id - The unique fraction ID (bytes32 hex string)
 * @param {string} applicationId - The ID of the application this fraction is for
 * @param {number} nonce - The nonce used to create the unique fraction ID
 * @param {string} createdBy - The wallet address of who created the fraction
 * @param {timestamp} createdAt - When the fraction was created
 * @param {timestamp} updatedAt - When the fraction was last updated
 * @param {boolean} isCommittedOnChain - Whether the fraction has been committed on-chain
 * @param {string} txHash - Transaction hash when committed on-chain (nullable)
 * @param {timestamp} committedAt - When the fraction was committed on-chain (nullable)
 * @param {number} sponsorSplitPercent - The sponsor split percentage for this fraction
 * @param {timestamp} expirationAt - When the fraction expires (4 weeks from creation)
 */
export const fractions = pgTable(
  "fractions",
  {
    id: varchar("fraction_id", { length: 66 }).primaryKey().notNull(), // bytes32 hex string (0x + 64 chars)
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    nonce: integer("nonce").notNull(),
    createdBy: varchar("created_by", { length: 42 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    isCommittedOnChain: boolean("is_committed_on_chain")
      .notNull()
      .default(false),
    txHash: varchar("tx_hash", { length: 66 }),
    committedAt: timestamp("committed_at"),
    isFilled: boolean("is_filled").notNull().default(false),
    filledAt: timestamp("filled_at"),
    sponsorSplitPercent: integer("sponsor_split_percent").notNull(),
    expirationAt: timestamp("expiration_at").notNull(),
    // Fields added for on-chain fraction commitment
    token: varchar("token", { length: 42 }), // ERC20 token address
    owner: varchar("owner", { length: 42 }), // Owner address that must match
    step: numeric("step", { precision: 78, scale: 0 }), // Price per step in token decimals (GLW 18 decimals, USDC 6 decimals)
    totalSteps: integer("total_steps").notNull(), // Total number of steps
    stepPrice: numeric("step_price", { precision: 78, scale: 0 }).notNull(), // Price per step in token decimals (GLW 18 decimals, USDC 6 decimals)
    splitsSold: integer("splits_sold").notNull().default(0), // Counter for sold splits
    status: varchar("status", { length: 20 }).notNull().default("draft"), // draft, committed, cancelled, filled, expired
    type: varchar("type", { length: 20 }).notNull().default("launchpad"), // launchpad, mining-center
    rewardScore: integer("reward_score"), // Reward score for launchpad fractions (nullable, e.g., 50, 100, 200)
  },
  (t) => ({
    applicationIdNonceIndex: uniqueIndex("application_id_nonce_unique_ix").on(
      t.applicationId,
      t.nonce
    ),
    createdByIndex: index("created_by_ix").on(t.createdBy),
    applicationIdIndex: index("fractions_application_id_ix").on(
      t.applicationId
    ),
    // Performance indexes for common query patterns
    typeIndex: index("fractions_type_idx").on(t.type),
    statusIndex: index("fractions_status_idx").on(t.status),
    statusTypeIndex: index("fractions_status_type_idx").on(t.status, t.type),
    statusFilledAtIndex: index("fractions_status_filled_at_idx").on(
      t.status,
      t.filledAt
    ),
  })
);

export type FractionType = InferSelectModel<typeof fractions>;
export type FractionInsertType = typeof fractions.$inferInsert;

/**
 * Tracks individual fraction split sales
 */
export const fractionSplits = pgTable(
  "fraction_splits",
  {
    id: serial("id").primaryKey(),
    fractionId: varchar("fraction_id", { length: 66 })
      .notNull()
      .references(() => fractions.id, { onDelete: "cascade" }),
    transactionHash: varchar("transaction_hash", { length: 66 }).notNull(),
    blockNumber: varchar("block_number", { length: 20 }).notNull(),
    logIndex: integer("log_index").notNull(),
    creator: varchar("creator", { length: 42 }).notNull(),
    buyer: varchar("buyer", { length: 42 }).notNull(),
    step: numeric("step", { precision: 78, scale: 0 }).notNull(), // Step price (in token decimals)
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(), // Amount (in token decimals)
    stepsPurchased: integer("steps_purchased").notNull(), // Number of steps purchased (amount / step)
    timestamp: integer("timestamp").notNull(), // Unix timestamp
    rewardScore: integer("reward_score"), // Snapshot reward score at time of split (launchpad only)
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    fractionIdIndex: index("fraction_splits_fraction_id_ix").on(t.fractionId),
    txHashLogIndex: uniqueIndex(
      "fraction_splits_tx_hash_log_index_unique_ix"
    ).on(t.transactionHash, t.logIndex),
    creatorIndex: index("fraction_splits_creator_ix").on(t.creator),
    buyerIndex: index("fraction_splits_buyer_ix").on(t.buyer),
    // Performance indexes for mining purchase queries (critical for impact score)
    timestampIndex: index("fraction_splits_timestamp_idx").on(t.timestamp),
    buyerTimestampIndex: index("fraction_splits_buyer_timestamp_idx").on(
      t.buyer,
      t.timestamp
    ),
    createdAtIndex: index("fraction_splits_created_at_idx").on(t.createdAt),
  })
);

export type FractionSplitType = InferSelectModel<typeof fractionSplits>;
export type FractionSplitInsertType = typeof fractionSplits.$inferInsert;

/**
 * Tracks fraction refunds issued to users
 */
export const fractionRefunds = pgTable(
  "fraction_refunds",
  {
    id: serial("id").primaryKey(),
    fractionId: varchar("fraction_id", { length: 66 })
      .notNull()
      .references(() => fractions.id, { onDelete: "cascade" }),
    transactionHash: varchar("transaction_hash", { length: 66 }).notNull(),
    blockNumber: varchar("block_number", { length: 20 }).notNull(),
    logIndex: integer("log_index").notNull(),
    creator: varchar("creator", { length: 42 }).notNull(), // Fraction creator address
    user: varchar("user", { length: 42 }).notNull(), // User who received the refund
    refundTo: varchar("refund_to", { length: 42 }).notNull(), // Address where refund was sent
    amount: numeric("amount", { precision: 78, scale: 0 }).notNull(), // Refund amount in the token decimals
    timestamp: integer("timestamp").notNull(), // Unix timestamp
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    fractionIdUserIndex: uniqueIndex(
      "fraction_refunds_fraction_id_user_unique_ix"
    ).on(t.fractionId, t.user), // Ensure one refund per user per fraction
    txHashLogIndex: uniqueIndex(
      "fraction_refunds_tx_hash_log_index_unique_ix"
    ).on(t.transactionHash, t.logIndex),
    userIndex: index("fraction_refunds_user_ix").on(t.user),
    fractionIdIndex: index("fraction_refunds_fraction_id_ix").on(t.fractionId),
  })
);

export type FractionRefundType = InferSelectModel<typeof fractionRefunds>;
export type FractionRefundInsertType = typeof fractionRefunds.$inferInsert;

export const FractionsRelations = relations(fractions, ({ one, many }) => ({
  application: one(applications, {
    fields: [fractions.applicationId],
    references: [applications.id],
  }),
  createdByWallet: one(wallets, {
    fields: [fractions.createdBy],
    references: [wallets.id],
  }),
  splits: many(fractionSplits),
  refunds: many(fractionRefunds),
}));

export const FractionSplitsRelations = relations(fractionSplits, ({ one }) => ({
  fraction: one(fractions, {
    fields: [fractionSplits.fractionId],
    references: [fractions.id],
  }),
  creatorWallet: one(wallets, {
    fields: [fractionSplits.creator],
    references: [wallets.id],
  }),
  buyerWallet: one(wallets, {
    fields: [fractionSplits.buyer],
    references: [wallets.id],
  }),
}));

export const FractionRefundsRelations = relations(
  fractionRefunds,
  ({ one }) => ({
    fraction: one(fractions, {
      fields: [fractionRefunds.fractionId],
      references: [fractions.id],
    }),
    creatorWallet: one(wallets, {
      fields: [fractionRefunds.creator],
      references: [wallets.id],
    }),
    userWallet: one(wallets, {
      fields: [fractionRefunds.user],
      references: [wallets.id],
    }),
    refundToWallet: one(wallets, {
      fields: [fractionRefunds.refundTo],
      references: [wallets.id],
    }),
  })
);

/**
 * Tracks failed fraction operations for retry and monitoring
 */
export const failedFractionOperations = pgTable(
  "failed_fraction_operations",
  {
    id: serial("id").primaryKey(),
    fractionId: varchar("fraction_id", { length: 66 }),
    operationType: varchar("operation_type", { length: 50 }).notNull(), // 'create', 'commit', 'fill', 'split', 'expire', 'cancel', 'refund'
    eventType: varchar("event_type", { length: 50 }), // 'fraction.created', 'fraction.sold', 'fraction.closed', 'fraction.refunded'
    eventPayload: json("event_payload"), // Store the full event payload for retry
    errorMessage: text("error_message").notNull(),
    errorStack: text("error_stack"),
    retryCount: integer("retry_count").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(3),
    status: varchar("status", { length: 20 }).notNull().default("pending"), // 'pending', 'retrying', 'failed', 'resolved'
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => ({
    fractionIdIndex: index("failed_fraction_operations_fraction_id_ix").on(
      t.fractionId
    ),
    statusIndex: index("failed_fraction_operations_status_ix").on(t.status),
    operationTypeIndex: index(
      "failed_fraction_operations_operation_type_ix"
    ).on(t.operationType),
    createdAtIndex: index("failed_fraction_operations_created_at_ix").on(
      t.createdAt
    ),
  })
);

export type FailedFractionOperationType = InferSelectModel<
  typeof failedFractionOperations
>;
export type FailedFractionOperationInsertType =
  typeof failedFractionOperations.$inferInsert;

/**
 * @dev Project quote requests for protocol deposit estimation.
 *      Stores uploaded utility bills, extracted electricity prices,
 *      and computed protocol deposit estimates with carbon metrics.
 */
export const ProjectQuotes = pgTable("project_quotes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  createdAt: timestamp("created_at").notNull().defaultNow(),

  // Wallet and user association
  walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
  userId: varchar("user_id", { length: 42 }),
  metadata: text("metadata"), // Optional field for partners to add identifying info (e.g., farm owner name)
  isProjectCompleted: boolean("is_project_completed").notNull().default(false), // Indicates if the solar project is already live/completed

  // Identity/Location
  regionCode: varchar("region_code", { length: 10 }).notNull(),
  latitude: numeric("latitude", { precision: 10, scale: 5 }).notNull(),
  longitude: numeric("longitude", { precision: 10, scale: 5 }).notNull(),

  // Inputs from user
  weeklyConsumptionMWh: numeric("weekly_consumption_mwh", {
    precision: 15,
    scale: 5,
  }).notNull(),
  systemSizeKw: numeric("system_size_kw", {
    precision: 12,
    scale: 3,
  }).notNull(),

  // Extracted from utility bill
  electricityPricePerKwh: numeric("electricity_price_per_kwh", {
    precision: 10,
    scale: 5,
  }).notNull(),
  priceSource: varchar("price_source", { length: 10 }).notNull().default("ai"),
  priceConfidence: numeric("price_confidence", { precision: 4, scale: 3 }),
  utilityBillUrl: text("utility_bill_url").notNull(),

  // Rates and assumptions used
  discountRate: numeric("discount_rate", { precision: 5, scale: 4 }).notNull(),
  escalatorRate: numeric("escalator_rate", {
    precision: 5,
    scale: 4,
  }).notNull(),
  years: integer("years").notNull().default(30),

  // Computed outputs (as text for precision)
  protocolDepositUsd6: text("protocol_deposit_usd6").notNull(),
  weeklyCredits: text("weekly_credits").notNull(),
  weeklyDebt: text("weekly_debt").notNull(),
  netWeeklyCc: text("net_weekly_cc").notNull(),
  netCcPerMwh: text("net_cc_per_mwh").notNull(),
  weeklyImpactAssetsWad: text("weekly_impact_assets_wad").notNull(),
  efficiencyScore: doublePrecision("efficiency_score").notNull(),
  carbonOffsetsPerMwh: numeric("carbon_offsets_per_mwh", {
    precision: 10,
    scale: 6,
  }).notNull(),
  uncertaintyApplied: numeric("uncertainty_applied", {
    precision: 5,
    scale: 4,
  }).notNull(),

  // Debug/audit trail
  debugJson: json("debug_json"),

  // Admin validation field (filled later)
  cashAmountUsd: text("cash_amount_usd"),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, approved, rejected, cancelled
});

export type ProjectQuoteType = InferSelectModel<typeof ProjectQuotes>;
export type ProjectQuoteInsertType = typeof ProjectQuotes.$inferInsert;

/**
 * @dev Tracks async batch submissions for project quote creation.
 *      Stores progress and (optionally) per-item results.
 */
export const ProjectQuoteBatches = pgTable("project_quote_batches", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),

  // Batch ownership (all items must be signed by the same wallet)
  walletAddress: varchar("wallet_address", { length: 42 }).notNull(),

  status: varchar("status", { length: 20 }).notNull().default("queued"), // queued, running, completed, failed
  itemCount: integer("item_count").notNull(),
  processedCount: integer("processed_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),

  etaSeconds: integer("eta_seconds"),
  results: json("results")
    .$type<
      Array<
        | { index: number; success: true; quoteId: string }
        | { index: number; success: false; error: string }
      >
    >()
    .default([]),
  error: text("error"),
});

export type ProjectQuoteBatchType = InferSelectModel<
  typeof ProjectQuoteBatches
>;
export type ProjectQuoteBatchInsertType =
  typeof ProjectQuoteBatches.$inferInsert;

/**
 * @dev API keys for partner integrations calling the Quote API without wallet signatures.
 *      Keys are stored hashed (sha256) and returned only once at creation time.
 */
export const QuoteApiKeys = pgTable(
  "quote_api_keys",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    createdAt: timestamp("created_at").notNull().defaultNow(),

    orgName: varchar("org_name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),

    // Optional: admin-configured wallet address to associate quotes with this key.
    // If set, API key-authenticated quote creation should use this wallet address instead of a pseudo wallet.
    walletAddress: varchar("wallet_address", { length: 42 }),

    // sha256(apiKey) hex string (64 chars). Do NOT store raw apiKey.
    apiKeyHash: varchar("api_key_hash", { length: 64 }).notNull(),
    last4: varchar("last4", { length: 4 }).notNull(),

    revokedAt: timestamp("revoked_at"),
  },
  (t) => ({
    orgNameUniqueIx: uniqueIndex("quote_api_keys_org_name_unique_ix").on(
      t.orgName
    ),
    apiKeyHashUniqueIx: uniqueIndex("quote_api_keys_api_key_hash_unique_ix").on(
      t.apiKeyHash
    ),
  })
);

export type QuoteApiKeyType = InferSelectModel<typeof QuoteApiKeys>;
export type QuoteApiKeyInsertType = typeof QuoteApiKeys.$inferInsert;

export const impactLeaderboardCache = pgTable(
  "impact_leaderboard_cache",
  {
    walletAddress: varchar("wallet_address", { length: 42 })
      .primaryKey()
      .notNull(),
    totalPoints: numeric("total_points", { precision: 20, scale: 6 }).notNull(),
    rank: integer("rank").notNull(),
    glowWorthWei: numeric("glow_worth_wei", {
      precision: 78,
      scale: 0,
    }).notNull(),
    lastWeekPoints: numeric("last_week_points", {
      precision: 20,
      scale: 6,
    }).notNull(),
    startWeek: integer("start_week").notNull(),
    endWeek: integer("end_week").notNull(),
    data: json("data").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // Composite indexes for common query patterns
    // Note: In Drizzle ORM v0.30.1, column ordering (.desc()/.asc()) is not supported in index definitions
    // The index will be created as ASC by default, but query performance is still improved
    // Ordering is handled by the orderBy clause in queries
    weekRangeTotalPointsIdx: index("impact_cache_week_total_points_idx").on(
      table.startWeek,
      table.endWeek,
      table.totalPoints
    ),
    weekRangeLastWeekPointsIdx: index(
      "impact_cache_week_last_week_points_idx"
    ).on(table.startWeek, table.endWeek, table.lastWeekPoints),
    weekRangeGlowWorthIdx: index("impact_cache_week_glow_worth_idx").on(
      table.startWeek,
      table.endWeek,
      table.glowWorthWei
    ),
  })
);

export const impactLeaderboardCacheByRegion = pgTable(
  "impact_leaderboard_cache_by_region",
  {
    id: serial("id").primaryKey(),
    walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
    regionId: integer("region_id").notNull(),
    directPoints: numeric("direct_points", {
      precision: 20,
      scale: 6,
    }).notNull(),
    glowWorthPoints: numeric("glow_worth_points", {
      precision: 20,
      scale: 6,
    }).notNull(),
    startWeek: integer("start_week").notNull(),
    endWeek: integer("end_week").notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    walletRegionWeekIndex: uniqueIndex("wallet_region_week_unique_ix").on(
      t.walletAddress,
      t.regionId,
      t.startWeek,
      t.endWeek
    ),
    regionIndex: index("region_id_ix").on(t.regionId),
  })
);

export type ImpactLeaderboardCacheByRegionType = InferSelectModel<
  typeof impactLeaderboardCacheByRegion
>;
export type ImpactLeaderboardCacheByRegionInsertType =
  typeof impactLeaderboardCacheByRegion.$inferInsert;

export const powerByRegionByWeek = pgTable(
  "power_by_region_by_week",
  {
    walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
    regionId: integer("region_id").notNull(),
    weekNumber: integer("week_number").notNull(),
    // Granular point components
    inflationPoints: numeric("inflation_points", {
      precision: 20,
      scale: 6,
    }).notNull(),
    steeringPoints: numeric("steering_points", {
      precision: 20,
      scale: 6,
    }).notNull(),
    vaultBonusPoints: numeric("vault_bonus_points", {
      precision: 20,
      scale: 6,
    }).notNull(),
    glowWorthPoints: numeric("glow_worth_points", {
      precision: 20,
      scale: 6,
    }).notNull(),
    // Totals for legacy support
    directPoints: numeric("direct_points", {
      precision: 20,
      scale: 6,
    }).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.walletAddress, table.regionId, table.weekNumber],
    }),
    weekRegionIdx: index("power_week_region_idx").on(
      table.weekNumber,
      table.regionId
    ),
  })
);

export type PowerByRegionByWeekType = InferSelectModel<
  typeof powerByRegionByWeek
>;
export type PowerByRegionByWeekInsertType =
  typeof powerByRegionByWeek.$inferInsert;

export const referralNonces = pgTable("referral_nonces", {
  walletAddress: varchar("wallet_address", { length: 42 }).primaryKey(),
  nonce: integer("nonce").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const referralFeatureLaunchSeen = pgTable(
  "referral_feature_launch_seen",
  {
    walletAddress: varchar("wallet_address", { length: 42 }).primaryKey(),
    featureLaunchSeenAt: timestamp("feature_launch_seen_at")
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  }
);

// ============================================
// Referral System Tables
// ============================================

export const referrals = pgTable(
  "referrals",
  {
    id: text("referral_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    // The wallet that referred (has the referral link)
    referrerWallet: varchar("referrer_wallet", { length: 42 }).notNull(),

    // The wallet that was referred (clicked the link)
    refereeWallet: varchar("referee_wallet", { length: 42 }).notNull().unique(),

    // Timestamps
    linkedAt: timestamp("linked_at").notNull().defaultNow(),
    gracePeriodEndsAt: timestamp("grace_period_ends_at").notNull(), // linkedAt + 7 days

    // Referee bonus tracking
    refereeBonusEndsAt: timestamp("referee_bonus_ends_at").notNull(), // linkedAt + 12 weeks

    // Status
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    // Values: "pending" (linked, < 100 pts), "active" (≥ 100 pts), "inactive" (referee dormant)

    // Activation tracking
    activatedAt: timestamp("activated_at"), // When referee reached 100 points threshold
    activationPointsThreshold: integer("activation_points_threshold")
      .notNull()
      .default(100),

    // One-time activation bonus (100 pts awarded when referee reaches 100 pts)
    activationBonusAwarded: boolean("activation_bonus_awarded")
      .notNull()
      .default(false),
    activationBonusAwardedAt: timestamp("activation_bonus_awarded_at"),

    // Modal tracking 
    featureLaunchSeenAt: timestamp("feature_launch_seen_at"),
    activationCelebrationSeenAt: timestamp("activation_celebration_seen_at"),

    // Referral code/link
    referralCode: varchar("referral_code", { length: 32 }).notNull(), // Unique code for the link

    // Previous referrer (for grace period changes)
    previousReferrerWallet: varchar("previous_referrer_wallet", { length: 42 }),
    referrerChangedAt: timestamp("referrer_changed_at"),

    // Metadata
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    // === UNIQUE CONSTRAINTS ===
    // One referrer per wallet (referee can only have one referrer)
    refereeWalletUniqueIdx: uniqueIndex(
      "referrals_referee_wallet_unique_ix"
    ).on(t.refereeWallet),

    // === QUERY INDEXES ===
    // Referral code lookup (NOT unique - many referees can use the same code)
    referralCodeIdx: index("referrals_referral_code_ix").on(t.referralCode),
    // Referrer lookup for all referrals
    referrerWalletIdx: index("referrals_referrer_wallet_ix").on(
      t.referrerWallet
    ),

    // Status filtering (for admin/cron queries + active referral lookups)
    referrerStatusIdx: index("referrals_referrer_status_ix").on(
      t.referrerWallet,
      t.status
    ),

    // Status-only index for filtering
    statusIdx: index("referrals_status_ix").on(t.status),

    // Grace period lookups (for "can change referrer" checks)
    gracePeriodIdx: index("referrals_grace_period_ix").on(
      t.refereeWallet,
      t.gracePeriodEndsAt
    ),

    // Bonus expiration (for cron that processes expiring bonuses)
    bonusEndsAtIdx: index("referrals_bonus_ends_at_ix").on(
      t.refereeBonusEndsAt
    ),

    // Linked at for time-based queries (recent referrals, etc.)
    linkedAtIdx: index("referrals_linked_at_ix").on(t.linkedAt),
  })
);

export type ReferralType = InferSelectModel<typeof referrals>;
export type ReferralInsertType = typeof referrals.$inferInsert;

export const referralCodes = pgTable(
  "referral_codes",
  {
    id: text("referral_code_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    walletAddress: varchar("wallet_address", { length: 42 }).notNull().unique(),

    // The unique code (e.g., "alice" from ENS, or short hash like "a7f3x2")
    code: varchar("code", { length: 32 }).notNull().unique(),

    // Full shareable link (cached for convenience)
    shareableLink: text("shareable_link").notNull(),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    // One code per wallet (bidirectional uniqueness)
    walletUniqueIdx: uniqueIndex("referral_codes_wallet_unique_ix").on(
      t.walletAddress
    ),

    // Codes must be unique across all wallets
    codeUniqueIdx: uniqueIndex("referral_codes_code_unique_ix").on(t.code),
  })
);

export type ReferralCodeType = InferSelectModel<typeof referralCodes>;
export type ReferralCodeInsertType = typeof referralCodes.$inferInsert;

export const referralPointsWeekly = pgTable(
  "referral_points_weekly",
  {
    id: text("referral_points_weekly_id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    // The referrer wallet earning points
    referrerWallet: varchar("referrer_wallet", { length: 42 }).notNull(),

    // The referee wallet generating points
    refereeWallet: varchar("referee_wallet", { length: 42 }).notNull(),

    // Week number (protocol week)
    weekNumber: integer("week_number").notNull(),

    // Referee's base points (pre-multiplier) for this week
    refereeBasePointsScaled6: numeric("referee_base_points_scaled6", {
      precision: 20,
      scale: 6,
    }).notNull(),

    // Referrer's earned points (20% of referee base)
    referrerEarnedPointsScaled6: numeric("referrer_earned_points_scaled6", {
      precision: 20,
      scale: 6,
    }).notNull(),

    // Referee's bonus points (10% of base, if within bonus period)
    refereeBonusPointsScaled6: numeric("referee_bonus_points_scaled6", {
      precision: 20,
      scale: 6,
    })
      .notNull()
      .default("0"),

    // One-time activation bonus (100 pts), recorded on activation week
    activationBonusPointsScaled6: numeric("activation_bonus_points_scaled6", {
      precision: 20,
      scale: 6,
    })
      .notNull()
      .default("0"),

    // Whether referee was in bonus period this week
    refereeBonusActive: boolean("referee_bonus_active")
      .notNull()
      .default(false),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    // === UNIQUE CONSTRAINTS ===
    // One record per referrer+referee+week combination
    uniqueIdx: uniqueIndex("referral_points_unique_ix").on(
      t.referrerWallet,
      t.refereeWallet,
      t.weekNumber
    ),

    // === QUERY INDEXES ===
    // Referrer's points by week
    referrerWeekIdx: index("referral_points_referrer_week_ix").on(
      t.referrerWallet,
      t.weekNumber
    ),

    // Referee lookup by week (for bonus calculations)
    refereeWeekIdx: index("referral_points_referee_week_ix").on(
      t.refereeWallet,
      t.weekNumber
    ),

    // Week-only index for cron batch processing
    weekIdx: index("referral_points_week_ix").on(t.weekNumber),

    // Compound index for bonus queries
    refereeBonusIdx: index("referral_points_referee_bonus_ix").on(
      t.refereeWallet,
      t.refereeBonusActive,
      t.weekNumber
    ),
  })
);

export type ReferralPointsWeeklyType = InferSelectModel<
  typeof referralPointsWeekly
>;
export type ReferralPointsWeeklyInsertType =
  typeof referralPointsWeekly.$inferInsert;

// ============================================
// Referral Relations
// ============================================

export const ReferralsRelations = relations(referrals, ({ one, many }) => ({
  referrer: one(wallets, {
    fields: [referrals.referrerWallet],
    references: [wallets.id],
    relationName: "referrer",
  }),
  referee: one(wallets, {
    fields: [referrals.refereeWallet],
    references: [wallets.id],
    relationName: "referee",
  }),
  weeklyPoints: many(referralPointsWeekly),
}));

export const ReferralCodesRelations = relations(referralCodes, ({ one }) => ({
  wallet: one(wallets, {
    fields: [referralCodes.walletAddress],
    references: [wallets.id],
  }),
}));

export const ReferralPointsWeeklyRelations = relations(
  referralPointsWeekly,
  ({ one }) => ({
    referral: one(referrals, {
      fields: [referralPointsWeekly.refereeWallet],
      references: [referrals.refereeWallet],
    }),
  })
);

// ============================================
// PoL Dashboard (CRM_POL_DASHBOARD_PLAN.MD)
// ============================================

/**
 * Manual bounty payments keyed by applicationId.
 * Stored in human USD with 2 decimals (e.g. 1500.00).
 */
export const polCashBounties = pgTable(
  "pol_cash_bounties",
  {
    applicationId: text("application_id")
      .primaryKey()
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    bountyUsd: numeric("bounty_usd", { precision: 20, scale: 2 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    updatedAtIdx: index("pol_cash_bounties_updated_at_ix").on(t.updatedAt),
  })
);

export type PolCashBountyType = InferSelectModel<typeof polCashBounties>;
export type PolCashBountyInsertType = typeof polCashBounties.$inferInsert;

/**
 * GLW vesting schedule for FDV/unlock widget.
 * `unlocked` is stored as a decimal amount (18 decimals) to preserve precision.
 */
export const glwVestingSchedule = pgTable(
  "glw_vesting_schedule",
  {
    date: varchar("date", { length: 10 }).primaryKey().notNull(), // YYYY-MM-DD
    unlocked: numeric("unlocked", { precision: 78, scale: 18 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    updatedAtIdx: index("glw_vesting_schedule_updated_at_ix").on(t.updatedAt),
  })
);

export type GlwVestingScheduleType = InferSelectModel<typeof glwVestingSchedule>;
export type GlwVestingScheduleInsertType =
  typeof glwVestingSchedule.$inferInsert;

/**
 * Snapshot of PoL yield inputs for the week (protocol week boundary).
 * LQ fields are stored as raw LQ with 12 decimals (atomic = 1e12).
 */
export const polYieldWeek = pgTable(
  "pol_yield_week",
  {
    weekNumber: integer("week_number").primaryKey().notNull(),
    strategyReturns90dLq: numeric("strategy_returns_90d_lq", {
      precision: 78,
      scale: 0,
    }).notNull(),
    uniFees90dLq: numeric("uni_fees_90d_lq", { precision: 78, scale: 0 })
      .notNull(),
    polStartLq: numeric("pol_start_lq", { precision: 78, scale: 0 }).notNull(),
    apy: numeric("apy", { precision: 30, scale: 18 }).notNull(),
    yieldPerWeekLq: numeric("yield_per_week_lq", { precision: 78, scale: 0 })
      .notNull(),
    indexingComplete: boolean("indexing_complete").notNull().default(false),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
  },
  (t) => ({
    fetchedAtIdx: index("pol_yield_week_fetched_at_ix").on(t.fetchedAt),
  })
);

export type PolYieldWeekType = InferSelectModel<typeof polYieldWeek>;
export type PolYieldWeekInsertType = typeof polYieldWeek.$inferInsert;

/**
 * Control API GCTL mint events (for region attribution and FMI inputs).
 * Amounts are stored in token atomic units.
 */
export const gctlMintEvents = pgTable(
  "gctl_mint_events",
  {
    txId: varchar("tx_id", { length: 66 }).primaryKey().notNull(),
    wallet: varchar("wallet", { length: 42 }).notNull(),
    epoch: integer("epoch").notNull(),
    currency: varchar("currency", { length: 16 }).notNull(), // USDC
    amountRaw: numeric("amount_raw", { precision: 78, scale: 0 }).notNull(), // USDC6
    gctlMintedRaw: numeric("gctl_minted_raw", { precision: 78, scale: 0 })
      .notNull(), // 18 decimals atomic
    ts: timestamp("ts").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    epochIdx: index("gctl_mint_events_epoch_ix").on(t.epoch),
    tsIdx: index("gctl_mint_events_ts_ix").on(t.ts),
    walletIdx: index("gctl_mint_events_wallet_ix").on(t.wallet),
  })
);

export type GctlMintEventType = InferSelectModel<typeof gctlMintEvents>;
export type GctlMintEventInsertType = typeof gctlMintEvents.$inferInsert;

/**
 * Weekly staked GCTL by region (Control API /regions/active/summary).
 */
export const gctlStakedByRegionWeek = pgTable(
  "gctl_staked_by_region_week",
  {
    weekNumber: integer("week_number").notNull(),
    region: varchar("region", { length: 255 }).notNull(),
    gctlStakedRaw: numeric("gctl_staked_raw", { precision: 78, scale: 0 })
      .notNull(), // 18 decimals atomic
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.weekNumber, t.region] }),
    weekIdx: index("gctl_staked_by_region_week_week_ix").on(t.weekNumber),
    regionIdx: index("gctl_staked_by_region_week_region_ix").on(t.region),
  })
);

export type GctlStakedByRegionWeekType = InferSelectModel<
  typeof gctlStakedByRegionWeek
>;
export type GctlStakedByRegionWeekInsertType =
  typeof gctlStakedByRegionWeek.$inferInsert;

/**
 * Weekly PoL revenue attribution snapshots.
 * LQ is stored as raw LQ with 12 decimals (atomic = 1e12).
 */
export const polRevenueByRegionWeek = pgTable(
  "pol_revenue_by_region_week",
  {
    weekNumber: integer("week_number").notNull(),
    region: varchar("region", { length: 255 }).notNull(),
    totalLq: numeric("total_lq", { precision: 78, scale: 0 }).notNull(),
    minerSalesLq: numeric("miner_sales_lq", { precision: 78, scale: 0 })
      .notNull()
      .default(sql`'0'::numeric`),
    gctlMintsLq: numeric("gctl_mints_lq", { precision: 78, scale: 0 })
      .notNull()
      .default(sql`'0'::numeric`),
    computedAt: timestamp("computed_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.weekNumber, t.region] }),
    weekIdx: index("pol_revenue_by_region_week_week_ix").on(t.weekNumber),
    regionIdx: index("pol_revenue_by_region_week_region_ix").on(t.region),
  })
);

export type PolRevenueByRegionWeekType = InferSelectModel<
  typeof polRevenueByRegionWeek
>;
export type PolRevenueByRegionWeekInsertType =
  typeof polRevenueByRegionWeek.$inferInsert;

export const polRevenueByFarmWeek = pgTable(
  "pol_revenue_by_farm_week",
  {
    weekNumber: integer("week_number").notNull(),
    farmId: varchar("farm_id").notNull(),
    totalLq: numeric("total_lq", { precision: 78, scale: 0 }).notNull(),
    minerSalesLq: numeric("miner_sales_lq", { precision: 78, scale: 0 })
      .notNull()
      .default(sql`'0'::numeric`),
    gctlMintsLq: numeric("gctl_mints_lq", { precision: 78, scale: 0 })
      .notNull()
      .default(sql`'0'::numeric`),
    computedAt: timestamp("computed_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.weekNumber, t.farmId] }),
    weekIdx: index("pol_revenue_by_farm_week_week_ix").on(t.weekNumber),
    farmIdx: index("pol_revenue_by_farm_week_farm_ix").on(t.farmId),
  })
);

export type PolRevenueByFarmWeekType = InferSelectModel<
  typeof polRevenueByFarmWeek
>;
export type PolRevenueByFarmWeekInsertType =
  typeof polRevenueByFarmWeek.$inferInsert;

/**
 * FMI weekly inputs snapshot (all USD fields stored as USDC6 atomic).
 */
export const fmiWeeklyInputs = pgTable(
  "fmi_weekly_inputs",
  {
    weekNumber: integer("week_number").primaryKey().notNull(),
    minerSalesUsd: numeric("miner_sales_usd", { precision: 78, scale: 0 })
      .notNull()
      .default(sql`'0'::numeric`),
    gctlMintsUsd: numeric("gctl_mints_usd", { precision: 78, scale: 0 })
      .notNull()
      .default(sql`'0'::numeric`),
    polYieldUsd: numeric("pol_yield_usd", { precision: 78, scale: 0 })
      .notNull()
      .default(sql`'0'::numeric`),
    dexSellPressureUsd: numeric("dex_sell_pressure_usd", {
      precision: 78,
      scale: 0,
    })
      .notNull()
      .default(sql`'0'::numeric`),
    buyPressureUsd: numeric("buy_pressure_usd", { precision: 78, scale: 0 })
      .notNull()
      .default(sql`'0'::numeric`),
    sellPressureUsd: numeric("sell_pressure_usd", { precision: 78, scale: 0 })
      .notNull()
      .default(sql`'0'::numeric`),
    netUsd: numeric("net_usd", { precision: 78, scale: 0 })
      .notNull()
      .default(sql`'0'::numeric`),
    buySellRatio: numeric("buy_sell_ratio", { precision: 30, scale: 18 }),
    indexingComplete: boolean("indexing_complete").notNull().default(false),
    computedAt: timestamp("computed_at").notNull().defaultNow(),
  },
  (t) => ({
    computedAtIdx: index("fmi_weekly_inputs_computed_at_ix").on(t.computedAt),
  })
);

export type FmiWeeklyInputsType = InferSelectModel<typeof fmiWeeklyInputs>;
export type FmiWeeklyInputsInsertType = typeof fmiWeeklyInputs.$inferInsert;
