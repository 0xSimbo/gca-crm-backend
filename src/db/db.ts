/* eslint-disable @typescript-eslint/ban-ts-comment */
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

const queryClient = postgres(process.env.DATABASE_URL!);
//@ts-ignore
export const db: PostgresJsDatabase = drizzle(queryClient);
