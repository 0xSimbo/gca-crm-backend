/* eslint-disable @typescript-eslint/ban-ts-comment */
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import { PG_DATABASE_URL, PG_ENV } from "./PG_ENV";
const queryClient = postgres(PG_DATABASE_URL, PG_ENV);

export const db: PostgresJsDatabase<typeof schema> = drizzle(queryClient, {
  schema,
});
