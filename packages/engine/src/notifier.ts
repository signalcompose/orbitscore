import { loadProjectEnv } from "./env";

export type NotifyMeta = Record<string, unknown> | undefined;

export interface Notifier {
  notify(text: string): Promise<void>;
  ask(question: string): Promise<{ id?: string } | void>;
}

export class SlackMCPNotifier implements Notifier {
  private baseUrl: string;
  private token?: string;
  private channel?: string;

  constructor(opts: { baseUrl: string; token?: string; channel?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.channel = opts.channel;
  }

  private headers() {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.token) h["authorization"] = `Bearer ${this.token}`;
    return h;
  }

  async notify(text: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/notify`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ text, channel: this.channel }),
      });
    } catch {}
  }

  async ask(question: string): Promise<{ id?: string } | void> {
    try {
      const res = await fetch(`${this.baseUrl}/ask`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ question, channel: this.channel }),
      });
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          return;
        }
      }
    } catch {}
  }
}

export class SlackApiNotifier implements Notifier {
  constructor(
    private token: string,
    private channel: string,
  ) {}

  async notify(text: string): Promise<void> {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ channel: this.channel, text }),
    });
    try {
      const json = await res.json();
      if (!(json && json.ok)) {
        console.error("Slack API error:", json?.error);
      }
    } catch {}
  }

  async ask(question: string): Promise<{ id?: string } | void> {
    await this.notify(`Question: ${question}`);
  }
}

export function createNotifierFromEnv(): Notifier | null {
  loadProjectEnv();
  const baseUrl = process.env.ORBITSCORE_MCP_BASE_URL as string | undefined;
  if (baseUrl) {
    return new SlackMCPNotifier({
      baseUrl,
      token: process.env.ORBITSCORE_MCP_TOKEN,
      channel: process.env.ORBITSCORE_SLACK_CHANNEL,
    });
  }
  const bot = process.env.ORBITSCORE_SLACK_BOT_TOKEN as string | undefined;
  const ch = process.env.ORBITSCORE_SLACK_CHANNEL as string | undefined;
  if (bot && ch) {
    return new SlackApiNotifier(bot, ch);
  }
  return null;
}
