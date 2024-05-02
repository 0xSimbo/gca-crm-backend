/* eslint-disable @typescript-eslint/ban-ts-comment */
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
const queryClient = postgres(process.env.DATABASE_URL!);
export const db: PostgresJsDatabase<typeof schema> = drizzle(queryClient, {
  schema,
});
