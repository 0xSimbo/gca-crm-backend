import { Elysia } from "elysia";
import { asc } from "drizzle-orm";
import { TAG } from "../../constants";
import { db } from "../../db/db";
import { glwVestingSchedule } from "../../db/schema";
import {
  getGlwVestingBreakdownFromTokenSupply,
  getGlwVestingScheduleFromTokenSupply,
} from "../../pol/vesting/tokenSupplyVestingSchedule";

function normalizeNumericToIntString(value: unknown): string {
  const raw = String(value ?? "0");
  // drizzle numeric may come back like "18000000.000000000000000000"
  const intPart = raw.includes(".") ? raw.split(".")[0] : raw;
  return /^\d+$/.test(intPart) ? intPart : "0";
}

export const glwRouter = new Elysia({ prefix: "/glw" })
  .get(
    "/vesting-schedule",
    async ({ set }) => {
      try {
        // Prefer the DB-backed schedule (seeded once, can be updated without deploy).
        const rows = await db
          .select()
          .from(glwVestingSchedule)
          .orderBy(asc(glwVestingSchedule.date));

        if (rows.length > 0) {
          return rows.map((r) => ({
            date: r.date,
            unlocked: normalizeNumericToIntString(r.unlocked),
          }));
        }

        // Fallback to derived schedule so non-seeded envs still work.
        return getGlwVestingScheduleFromTokenSupply();
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return { error: e.message };
        }
        set.status = 500;
        return { error: "Internal Server Error" };
      }
    },
    {
      detail: {
        summary: "GLW vesting unlock schedule",
        tags: [TAG.TOKEN],
      },
    }
  )
  .get(
    "/vesting-breakdown",
    async ({ set }) => {
      try {
        // Derived breakdown schedule from the token supply dataset (authoritative caps
        // + rule-based unlock windows, ends at 180M by default).
        return getGlwVestingBreakdownFromTokenSupply();
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return { error: e.message };
        }
        set.status = 500;
        return { error: "Internal Server Error" };
      }
    },
    {
      detail: {
        summary: "GLW vesting schedule breakdown (by allocation bucket)",
        tags: [TAG.TOKEN],
      },
    }
  );
