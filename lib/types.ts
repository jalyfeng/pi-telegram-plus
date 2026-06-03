import type { AgentSession, ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type TelegramRenderLevel = "hidden" | "brief" | "full";
export type TelegramMessageMode = "queue" | "steer";

export const RENDER_LEVELS: readonly TelegramRenderLevel[] = ["hidden", "brief", "full"] as const;
export const MODE_VALUES: readonly TelegramMessageMode[] = ["queue", "steer"] as const;

export type TelegramConfigStore = {
  version: 2;
  global?: TelegramConfig;
  workspaces?: TelegramWorkspaceConfig[];
};

export type TelegramWorkspaceConfig = {
  path: string;
  config: TelegramConfig;
};

export type ResolvedTelegramConfig = {
  store: TelegramConfigStore;
  scope: "global" | "workspace";
  workspacePath?: string;
  config: TelegramConfig;
};

export type TelegramConfig = {
  botToken?: string;
  botUsername?: string;
  telegramEnabled?: boolean;
  allowedUserId?: number;
  /** Last chat that interacted with the bot. */
  activeChatId?: number;
  lastUpdateId?: number;
  /** How to render tool executions in Telegram. */
  tool?: TelegramRenderLevel;
  /** How to render thinking blocks in Telegram. */
  thinking?: TelegramRenderLevel;
  /** How to handle incoming messages while the agent is running.
   *  "steer" — messages inject into the current turn via streamingBehavior (default).
   *  "queue" — messages wait for the current turn to finish.
   */
  messageMode?: TelegramMessageMode;
  /** Number of retries for failed Telegram API calls (0 = no retry, default 3). */
  retryCount?: number;
};

export type TelegramPhotoSize = {
  file_id: string;
  file_size?: number;
};

export type TelegramDocument = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
};

export type TelegramMessage = {
  message_id: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramDocument;
  audio?: TelegramDocument;
  voice?: TelegramDocument;
  animation?: TelegramDocument;
  sticker?: TelegramDocument;
  chat?: { id?: number };
  from?: { id?: number };
  reply_to_message?: { message_id?: number };
};

export type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: TelegramMessage;
  from?: { id?: number };
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

export type TelegramButton = { text: string; value: string };
export type PendingInputResolver = (value: string | boolean | undefined) => void;

export type TelegramSentMessage = { message_id: number };

export type TelegramTurn = {
  chatId: number;
  /** Message to edit in-place for callback-button initiated turns. */
  replaceMessageId?: number;
  queuedAttachments: Array<{ path: string; fileName: string }>;
  attachmentsSent?: boolean;
};

export type TelegramTransport = {
  removeInlineKeyboard(chatId: number, messageId: number): Promise<void>;
  sendText(chatId: number, text: string): Promise<TelegramSentMessage[]>;
  sendButtons(
    chatId: number,
    text: string,
    rows: TelegramButton[][],
  ): Promise<TelegramSentMessage>;
  editText(chatId: number, messageId: number, text: string): Promise<void>;
  editButtons(chatId: number, messageId: number, text: string, rows: TelegramButton[][]): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  sendDocument(chatId: number, path: string, caption?: string, signal?: AbortSignal): Promise<void>;
  sendPhoto(chatId: number, data: string, caption?: string, isPath?: boolean, signal?: AbortSignal): Promise<void>;
  sendChatAction(chatId: number, action: string): Promise<void>;
};

export type CapturedAgentSession = AgentSession & {
  extensionRunner: AgentSession["extensionRunner"] & {
    getUIContext(): ExtensionUIContext;
    setUIContext(ui?: ExtensionUIContext): void;
  };
};