import type { NotificationSender, TradeNotification, NotificationConfig } from "./types";

export interface TelegramConfig extends NotificationConfig {
  botToken: string;
  chatId: string;
}

const LEVEL_EMOJI: Record<string, string> = {
  info: "ℹ️",
  warn: "⚠️",
  error: "🚨",
  success: "✅",
};

const TYPE_EMOJI: Record<string, string> = {
  order_filled: "📝",
  position_opened: "📈",
  position_closed: "📉",
  stop_loss: "🛑",
  token_expired: "⏰",
  custom: "📢",
};

const LOG_PREFIX = "[Telegram]";
const PREVIEW_LIMIT = 240;

function maskSecret(value: string, revealStart = 4, revealEnd = 4): string {
  if (!value) return "missing";
  if (value.length <= revealStart + revealEnd + 2) {
    return `${value.slice(0, 1)}...${value.slice(-1)} (len=${value.length})`;
  }
  return `${value.slice(0, revealStart)}...${value.slice(-revealEnd)} (len=${value.length})`;
}

function maskChatId(value: string): string {
  if (!value) return "missing";
  if (value.length <= 4) return `***${value}`;
  return `***${value.slice(-4)}`;
}

function previewText(text: string): string {
  if (text.length <= PREVIEW_LIMIT) {
    return text;
  }
  return `${text.slice(0, PREVIEW_LIMIT)}...`;
}

function formatNotificationMessage(notification: TradeNotification, accountLabel?: string): string {
  const levelEmoji = LEVEL_EMOJI[notification.level] ?? "";
  const typeEmoji = TYPE_EMOJI[notification.type] ?? "";
  const timestamp = notification.timestamp ?? Date.now();
  const time = new Date(timestamp).toISOString().replace("T", " ").substring(0, 19);

  const label = notification.accountLabel ?? accountLabel ?? notification.symbol;

  const lines: string[] = [
    `${typeEmoji}${levelEmoji} [${label}] ${notification.title}`,
    ``,
    `${notification.message}`,
  ];

  if (notification.details && Object.keys(notification.details).length > 0) {
    lines.push(``);
    for (const [key, value] of Object.entries(notification.details)) {
      if (value != null) {
        lines.push(`• ${key}: ${value}`);
      }
    }
  }

  lines.push(``);
  lines.push(`🕐 ${time} UTC`);
  lines.push(`📊 ${notification.symbol}`);

  return lines.join("\n");
}

export class TelegramNotifier implements NotificationSender {
  private readonly config: TelegramConfig;
  private readonly baseUrl: string;
  private sendQueue: Promise<void> = Promise.resolve();
  private disabledLogged = false;

  constructor(config: Partial<TelegramConfig> = {}) {
    this.config = {
      enabled: Boolean(config.botToken && config.chatId),
      botToken: config.botToken ?? "",
      chatId: config.chatId ?? "",
      accountLabel: config.accountLabel,
    };
    this.baseUrl = `https://api.telegram.org/bot${this.config.botToken}`;
    console.info(`${LOG_PREFIX} Notifier config`, {
      enabled: this.config.enabled,
      botToken: maskSecret(this.config.botToken),
      chatId: maskChatId(this.config.chatId),
      accountLabel: this.config.accountLabel ?? "none",
    });
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async send(notification: TradeNotification): Promise<void> {
    if (!this.isEnabled()) {
      if (!this.disabledLogged) {
        console.warn(`${LOG_PREFIX} Skipping send (missing bot token or chat id).`, {
          botToken: maskSecret(this.config.botToken),
          chatId: maskChatId(this.config.chatId),
        });
        this.disabledLogged = true;
      }
      return;
    }

    console.info(`${LOG_PREFIX} Queueing notification`, {
      type: notification.type,
      level: notification.level,
      title: notification.title,
      chatId: maskChatId(this.config.chatId),
    });
    this.sendQueue = this.sendQueue
      .then(() => this.doSend(notification))
      .catch(() => {});
  }

  private async doSend(notification: TradeNotification): Promise<void> {
    const text = formatNotificationMessage(notification, this.config.accountLabel);
    const url = `${this.baseUrl}/sendMessage`;

    try {
      console.info(`${LOG_PREFIX} Sending notification`, {
        chatId: maskChatId(this.config.chatId),
        textLength: text.length,
        textPreview: previewText(text),
      });
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
        }),
      });

      const responseText = await response.text().catch(() => "unknown response");
      console.info(`${LOG_PREFIX} Response`, {
        ok: response.ok,
        status: response.status,
        body: responseText,
      });
      if (!response.ok) {
        console.error(`${LOG_PREFIX} Failed to send notification: ${response.status} ${responseText}`);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Failed to send notification: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function createTelegramNotifier(): TelegramNotifier {
  return new TelegramNotifier({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    accountLabel: process.env.TELEGRAM_ACCOUNT_LABEL,
  });
}
