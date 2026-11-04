export type PiRunnerCompat = {
  getUIContext?(): unknown;
  setUIContext?(ui?: unknown, mode?: PiExtensionMode): void;
  createContext?(): { mode?: PiExtensionMode };
  mode?: PiExtensionMode;
  uiContext?: unknown;
};

export type PiExtensionMode = "tui" | "rpc" | "json" | "print" | string;

export const TELEGRAM_EXTENSION_MODE: PiExtensionMode = "rpc";

export function getRunnerMode(runner: PiRunnerCompat | undefined, fallback: PiExtensionMode = "tui"): PiExtensionMode {
  try {
    const mode = runner?.createContext?.().mode;
    if (typeof mode === "string") return mode;
  } catch {
    // Disposed runners throw in createContext's assertActive; fall back below.
  }
  return typeof runner?.mode === "string" ? runner.mode : fallback;
}

const PI_PROMPT_METHODS = new Set(["select", "confirm", "input", "editor", "custom"]);

export function isRoutedUi(ui: unknown): boolean {
  return typeof ui === "object" && ui !== null && (ui as any).__piTelegramPlusRoutedUi === true;
}

/**
 * The host UI underneath a Telegram routed/dispatch UI. Code that captures a UI
 * for later reads (e.g. a TUI base for forwarding) must hold this, not a routed
 * wrapper: a wrapper resolves back to the Telegram turn's UI, which forwards to
 * the captured value, and every read of that property recurses without end.
 */
export function hostUiBehindRouted(ui: unknown): unknown {
  let current = ui;
  for (let depth = 0; isRoutedUi(current) && depth < 8; depth += 1) {
    const base = (current as any).__piTelegramPlusRoutedBaseUi;
    if (typeof base !== "object" || base === null || base === current) break;
    current = base;
  }
  return current;
}

function createPromptPreservingRoutedUi(routedUi: object, wrappedUi: object): unknown {
  return new Proxy({}, {
    get(_target, prop, receiver) {
      if (typeof prop === "string" && PI_PROMPT_METHODS.has(prop)) {
        const value = Reflect.get(wrappedUi, prop);
        return typeof value === "function" ? value.bind(wrappedUi) : value;
      }
      return Reflect.get(routedUi, prop);
    },
    set(_target, prop, value, receiver) {
      if (typeof prop === "string" && PI_PROMPT_METHODS.has(prop)) {
        return Reflect.set(wrappedUi, prop, value);
      }
      return Reflect.set(routedUi, prop, value, receiver);
    },
    has(_target, prop) {
      if (typeof prop === "string" && PI_PROMPT_METHODS.has(prop)) {
        return prop in wrappedUi;
      }
      return prop in routedUi;
    },
    ownKeys(_target) {
      const keys = new Set(Reflect.ownKeys(routedUi));
      for (const method of PI_PROMPT_METHODS) {
        if (method in wrappedUi) {
          keys.add(method);
        }
      }
      return Array.from(keys);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "string" && PI_PROMPT_METHODS.has(prop)) {
        const desc = Reflect.getOwnPropertyDescriptor(wrappedUi, prop);
        if (desc) return { ...desc, configurable: true };
        if (prop in wrappedUi) {
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: Reflect.get(wrappedUi, prop),
          };
        }
      }
      const desc = Reflect.getOwnPropertyDescriptor(routedUi, prop);
      if (desc) return { ...desc, configurable: true };
      if (prop in routedUi) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: Reflect.get(routedUi, prop),
        };
      }
      return undefined;
    },
  });
}

export function setRunnerUiContext(
  runner: PiRunnerCompat | undefined,
  ui: unknown,
  mode: PiExtensionMode = TELEGRAM_EXTENSION_MODE,
): void {
  if (!runner) return;
  if (typeof runner.setUIContext === "function") {
    runner.setUIContext(ui as any, mode);
  }
  // pi's runner.setUIContext wraps the provided UI with prompt-tracking handlers
  // ({ ...ui, select, confirm, ... }) (wrapUIPromptContext). The object spread
  // flattens dynamically routed methods at registration time. Wrap the runner's
  // uiContext in a composite proxy so prompt lifecycle events are preserved
  // while other UI methods route dynamically.
  if (isRoutedUi(ui) && (runner as any).uiContext !== undefined) {
    const wrappedUi = (runner as any).uiContext;
    if (wrappedUi && wrappedUi !== ui) {
      (runner as any).uiContext = createPromptPreservingRoutedUi(ui as object, wrappedUi as object);
    }
  }
}

export function restoreRunnerUiContext(
  runner: PiRunnerCompat | undefined,
  ui: unknown,
  mode: PiExtensionMode,
): void {
  if (!runner) return;
  if (typeof runner.setUIContext === "function") {
    runner.setUIContext(ui as any, mode);
  }
  // Restore the exact base UI context captured prior to Telegram turns, preventing
  // wrapUIPromptContext from accumulating nested wrappers across multiple turns.
  if ((runner as any).uiContext !== undefined) {
    (runner as any).uiContext = ui;
  }
}

function redactKnownTokenPrefix(value: string): string {
  if (value.startsWith("sk-")) return "sk-…";
  if (value.startsWith("AIza")) return "AIza…";
  if (value.startsWith("github_pat_")) return "github_pat_…";
  if (/^gh[pousr]_/.test(value)) return `${value.slice(0, 4)}…`;
  if (value.startsWith("hf_")) return "hf_…";
  if (value.startsWith("nvapi-")) return "nvapi-…";
  if (/^xox[abprs]-/.test(value)) return `${value.slice(0, 5)}…`;
  if (value.startsWith("ya29.")) return "ya29.…";
  return "…";
}

function looksSecretLike(value: string): boolean {
  return value.length >= 8 && /^[A-Za-z0-9._~+/=-]+$/.test(value);
}

function redactLabeledSecret(
  match: string,
  labelQuote: string,
  label: string,
  separator: string,
  valueQuote: string,
  authScheme: string | undefined,
  value: string,
): string {
  const normalizedLabel = label.toLowerCase().replace(/[\s_-]+/g, "_");
  const isGenericKey = normalizedLabel === "key";
  if (isGenericKey && !looksSecretLike(value)) return match;
  const isAuthorization = normalizedLabel === "authorization" || normalizedLabel === "proxy_authorization";
  const safeScheme = isAuthorization ? authScheme ?? "" : "";
  return `${labelQuote}${label}${labelQuote}${separator}${valueQuote}${safeScheme}…${valueQuote}`;
}

function redactUnschemedLabeledSecret(
  match: string,
  labelQuote: string,
  label: string,
  separator: string,
  valueQuote: string,
  value: string,
): string {
  return redactLabeledSecret(match, labelQuote, label, separator, valueQuote, undefined, value);
}

export function commandErrorMessage(error: unknown, maxLength = 500): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/([?&](?:code|access_token|refresh_token|token|api[_-]?key|key)=)([^&#\s"'{}]+)/gi, "$1…")
    .replace(
      /(["']?)\b((?:proxy[\s_-]*)?authorization)\b\1(\s*[:=]\s*)(["']?)([A-Za-z][A-Za-z0-9._~-]*\s+)?([^"'\s,;&?#{}]+)\4/gi,
      redactLabeledSecret,
    )
    .replace(
      /(["']?)\b((?:x-)?api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|secret|token|key)\b\1(\s*[:=]\s*)(["']?)([^"'\s,;&?#{}]+)\4/gi,
      redactUnschemedLabeledSecret,
    )
    .replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{8,}|github_pat_[0-9A-Za-z_]{8,}|gh[pousr]_[0-9A-Za-z_]{8,}|hf_[0-9A-Za-z]{8,}|nvapi-[0-9A-Za-z_-]{8,}|xox[abprs]-[0-9A-Za-z-]{8,}|ya29\.[0-9A-Za-z._-]{8,})\b/g,
      redactKnownTokenPrefix,
    );
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 1)}…`;
}
