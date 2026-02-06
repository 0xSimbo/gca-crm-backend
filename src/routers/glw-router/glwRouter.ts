import { Elysia } from "elysia";
import { asc } from "drizzle-orm";
import { TAG } from "../../constants";
import { db } from "../../db/db";
import { glwVestingSchedule } from "../../db/schema";

export const glwRouter = new Elysia({ prefix: "/glw" }).get(
  "/vesting-schedule",
  async ({ set }) => {
    try {
      const rows = await db
        .select()
        .from(glwVestingSchedule)
        .orderBy(asc(glwVestingSchedule.date));

      return rows.map((r) => ({
        date: r.date,
        unlocked: String(r.unlocked),
      }));
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
);

