import { WebClient } from '@slack/web-api';

export function createSlackClient(token: string) {
  const client = new WebClient(token);

  return {
    /* mimic grammy’s “bot.api” sub-namespace */
    api: {
      async sendMessage(channel: string, text: string, _opts?: unknown) {
        await client.chat.postMessage({ channel, text, mrkdwn: true });
      },
      /* no-ops so existing calls still type-check */
      async pinChatMessage() {
        /* Slack pinning optional */
      },
      async getChat() {
        return { pinned_message: null };
      },
    },
    /* stubs so index.ts can still call bot.start() */
    start() {
      /* nothing to start for Web API */
    },
  };
}
