import { pgTable, varchar, integer } from "drizzle-orm/pg-core";
import { type InferSelectModel } from "drizzle-orm";
import { nanoid } from "nanoid";

export const users = pgTable("users", {
  id: varchar("wallet", { length: 42 }).primaryKey().notNull(),
  totalPoints: integer("total_points").default(0).notNull(),
});

export type UserType = InferSelectModel<typeof users>;
