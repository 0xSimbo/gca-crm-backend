import { Elysia } from "elysia";
import { TAG } from "../../constants";
import { getGlwVestingScheduleFromTokenSupply } from "../../pol/vesting/tokenSupplyVestingSchedule";

export const glwRouter = new Elysia({ prefix: "/glw" }).get(
  "/vesting-schedule",
  async ({ set }) => {
    try {
      // Canonical schedule comes from `data/tokenSupplyOverTimeData.ts` (monthly, cumulative unlocked).
      // This avoids relying on a manually-pushed DB seed for a static dataset.
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
);
