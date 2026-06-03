/**
 * Parse and normalize Telegram slash commands.
 */

export function parseLeadingCommand(text: string): { name: string; args: string } | undefined {
  const match = text.match(/^\/([^\s@]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return { name: match[1], args: match[2] ?? "" };
}

export function normalizeLeadingCommand(text: string, botUsername: string | undefined): string {
  if (!botUsername) return text;
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^(\\/[^\\s@]+)@${escaped}(\\s|$)`, "i"), "$1$2");
}