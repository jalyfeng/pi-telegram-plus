export const UI_CALLBACK_PREFIX = "tgplus:ui:";

export function encodeUiCallback(value: string): string {
  return `${UI_CALLBACK_PREFIX}${value}`;
}

export function decodeUiCallback(data: string): string | undefined {
  return data.startsWith(UI_CALLBACK_PREFIX) ? data.slice(UI_CALLBACK_PREFIX.length) : undefined;
}