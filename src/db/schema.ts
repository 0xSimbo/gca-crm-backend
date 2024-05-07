import {
  pgTable,
  varchar,
  integer,
  primaryKey,
  bigint,
  pgEnum,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations, type InferSelectModel, sql } from "drizzle-orm";

// UNKNOWN is a special role that is used when the user didn't yet filled the solar farm owner form or the GCA form
export const accountRoles = ["FARM_OWNER", "GCA", "ADMIN", "UNKNOWN"] as const;

export const accountRoleEnum = pgEnum("role", accountRoles);

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
    userId: varchar("wallet", { length: 42 }).notNull(),
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

export type UserType = InferSelectModel<typeof users>;
export type UserWeeklyRewardType = InferSelectModel<typeof userWeeklyReward>;

export const accounts = pgTable("accounts", {
  id: varchar("wallet", { length: 42 }).primaryKey().notNull(),
  role: accountRoleEnum("role"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});
export type AccountType = InferSelectModel<typeof accounts>;

export const farmOwners = pgTable("farmOwners", {
  id: varchar("wallet", { length: 42 }).primaryKey().notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  firstName: varchar("first_name", { length: 255 }).notNull(),
  lastName: varchar("last_name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  companyName: varchar("company_name", { length: 255 }),
  companyAddress: varchar("company_address", { length: 255 }),
});
export type farmOwnerType = InferSelectModel<typeof farmOwners>;

export const gcas = pgTable("gcas", {
  id: varchar("wallet", { length: 42 }).primaryKey().notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  publicEncriptionKey: varchar("public_encription_key", {
    length: 255,
  }).notNull(),
  serverUrls: varchar("server_urls", { length: 255 }).array().notNull(),
});
export type gcaType = InferSelectModel<typeof gcas>;

export const accountsRelations = relations(accounts, ({ one }) => ({
  farmOwner: one(farmOwners),
  gca: one(gcas),
}));
