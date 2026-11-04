/**
 * Descriptions the plugin registered for the commands it serves on Telegram.
 * Filled by the command registry (lib/commands/register.ts and tg-menu.ts) and
 * read by the BotMenu builder (lib/menu-commands.ts), which decides priority.
 */
const registered = new Map<string, string>();

export function recordTelegramCommandDescription(name: string, description: string | undefined): void {
  const trimmed = description?.trim();
  if (trimmed) registered.set(name, trimmed);
}

export function getTelegramCommandDescriptions(): ReadonlyMap<string, string> {
  return registered;
}
