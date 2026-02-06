import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { db } from "../../db/db";
import { getCompletedWeekNumber } from "../../pol/protocolWeeks";

export const fmiRouter = new Elysia({ prefix: "/fmi" }).get(
  "/pressure",
  async ({ query, set }) => {
    try {
      // Current implementation is weekly snapshots, so 7d maps to the latest completed week.
      // We keep the range param for forward compatibility (series endpoints on FE).
      void query.range;

      const week = getCompletedWeekNumber();
      const row = await db.query.fmiWeeklyInputs.findFirst({
        where: (t, { eq }) => eq(t.weekNumber, week),
      });

      if (!row) {
        set.status = 404;
        return { error: "No FMI snapshot for latest completed week" };
      }

      return {
        week,
        miner_sales_weekly_usd: String(row.minerSalesUsd),
        gctl_mints_weekly_usd: String(row.gctlMintsUsd),
        pol_yield_weekly_usd: String(row.polYieldUsd),
        dex_sell_pressure_weekly_usd: String(row.dexSellPressureUsd),
        buy_pressure: String(row.buyPressureUsd),
        sell_pressure: String(row.sellPressureUsd),
        net: String(row.netUsd),
        buy_sell_ratio: row.buySellRatio ? String(row.buySellRatio) : null,
      };
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
    query: t.Object({
      range: t.Optional(t.String()),
    }),
    detail: {
      summary: "FMI buy/sell pressure inputs (weekly snapshot)",
      tags: [TAG.FMI],
    },
  }
);
