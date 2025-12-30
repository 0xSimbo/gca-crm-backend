import { db } from "../../db";
import { ProjectQuotes, ProjectQuoteInsertType } from "../../schema";
import { createSlackClient } from "../../../slack/create-slack-client";

const SLACK_CHANNEL = process.env.SLACK_QUOTES_CHANNEL ?? "#devs";
const WEEKS_PER_YEAR = 52.18;

export async function createProjectQuote(data: ProjectQuoteInsertType) {
  const [quote] = await db.insert(ProjectQuotes).values(data).returning();

  if (quote && process.env.SLACK_BOT_TOKEN) {
    try {
      const slackBot = createSlackClient(process.env.SLACK_BOT_TOKEN);

      const weeklyConsumptionMWh = Number.parseFloat(
        String(quote.weeklyConsumptionMWh)
      );
      const annualConsumptionMWh = Number.isFinite(weeklyConsumptionMWh)
        ? weeklyConsumptionMWh * WEEKS_PER_YEAR
        : null;

      const systemSizeKw = Number.parseFloat(String(quote.systemSizeKw));

      const slackMessage =
        `🧾 *New Project Quote Created*\n\n` +
        `*Quote ID:* ${quote.id}\n` +
        `*Region:* ${quote.regionCode}\n` +
        `*Wallet:* ${quote.walletAddress}\n` +
        `*User ID:* ${quote.userId ?? "null"}\n` +
        `*Price Source:* ${quote.priceSource}\n` +
        `*Electricity Price (USD/kWh):* ${quote.electricityPricePerKwh}\n` +
        `*Consumption (annual MWh):* ${
          annualConsumptionMWh !== null
            ? annualConsumptionMWh.toFixed(6)
            : "n/a"
        }\n` +
        `*System Size (kW):* ${
          Number.isFinite(systemSizeKw) ? systemSizeKw.toFixed(3) : "n/a"
        }\n` +
        `*Project Completed:* ${quote.isProjectCompleted}\n` +
        `*Metadata:* ${quote.metadata ?? "null"}\n` +
        `*Time:* ${new Date().toISOString()}\n` +
        `*Environment:* ${process.env.NODE_ENV || "unknown"}`;

      await slackBot.api.sendMessage(SLACK_CHANNEL, slackMessage);
    } catch (slackError) {
      console.error(
        "[createProjectQuote] Failed to send Slack notification:",
        slackError
      );
      // Don't fail quote creation if Slack notification fails.
    }
  }

  return quote;
}
