import { createSlackClient } from "./create-slack-client";

const SLACK_CHANNEL = process.env.SLACK_QUOTES_CHANNEL ?? "#devs";

interface SendQuoteBatchSummaryArgs {
  kind: "project" | "lebanon";
  walletAddress: string;
  itemCount: number;
  successCount: number;
  errorCount: number;
  batchId?: string;
  statusEndpoint?: string;
  error?: string | null;
}

export async function sendQuoteBatchSummaryToSlack(
  args: SendQuoteBatchSummaryArgs
) {
  if (!process.env.SLACK_BOT_TOKEN) return;

  const slackBot = createSlackClient(process.env.SLACK_BOT_TOKEN);
  const env = process.env.NODE_ENV || "unknown";

  const header =
    args.errorCount > 0 || args.error
      ? "🧾 *Quote Batch Completed (with errors)*"
      : "🧾 *Quote Batch Completed*";

  const kindLabel = args.kind === "lebanon" ? "Lebanon" : "Project";

  const message =
    `${header}\n\n` +
    `*Kind:* ${kindLabel}\n` +
    (args.batchId ? `*Batch ID:* ${args.batchId}\n` : "") +
    (args.statusEndpoint ? `*Status:* ${args.statusEndpoint}\n` : "") +
    `*Wallet:* ${args.walletAddress}\n` +
    `*Item Count:* ${args.itemCount}\n` +
    `*Success:* ${args.successCount}\n` +
    `*Errors:* ${args.errorCount}\n` +
    (args.error ? `*Batch Error:* ${args.error}\n` : "") +
    `*Time:* ${new Date().toISOString()}\n` +
    `*Environment:* ${env}`;

  await slackBot.api.sendMessage(SLACK_CHANNEL, message);
}


