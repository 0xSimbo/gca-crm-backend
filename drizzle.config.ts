import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { PG_ENV } from "./src/db/PG_ENV";
config({ path: ".env" });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { ...PG_ENV, ssl: true },
});
