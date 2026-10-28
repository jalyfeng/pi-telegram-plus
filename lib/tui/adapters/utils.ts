/**
 * Shared adapter helpers (§4.6).
 *
 * Two invariants every adapter keeps:
 * - Nothing is invented. A model only reports what the live component said
 *   when it was read; a stale button is reported, never guessed at.
 * - Nothing is poked. Actions travel the same path a keyboard takes, so the
 *   component refreshes its own internal state. Direct field writes happen
 *   only where the component exposes a setter for exactly that purpose.
 */

/** OMP versions the plugin supports: startup refuses anything else (§0.1). Single copy - tui-bridge gates on it too. */
export const SUPPORTED_OMP_VERSIONS = /^18\.12\./;

/** CSI sequences, OSC strings and stray control bytes that colour the render. */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|[\x07\x08]/g;

/**
 * Strip ANSI so text parsing never depends on the active theme. pi-tui renders
 * either one string or one string per line: both have to come out as text, or
 * every adapter that parses the render reads an empty screen.
 */
export function plain(value: unknown): string {
  if (typeof value === "string") return value.replace(ANSI_PATTERN, "");
  if (Array.isArray(value)) return value.map((line) => plain(line)).join("\n");
  return "";
}

/**
 * Row identity: "index + label" (§4.6.2). The index makes a repeated label
 * addressable; the label lets the reverse lookup notice that the terminal list
 * changed underneath us.
 */
export function rowKey(index: number, label: string): string {
  return `${index}:${label}`;
}

/** Turn a key back into a live index, or `undefined` when the row is gone. */
export function resolveRowKey(labels: string[], key: string): number | undefined {
  const separator = key.indexOf(":");
  if (separator < 0) {
    const direct = labels.indexOf(key);
    return direct >= 0 ? direct : undefined;
  }
  const index = Number.parseInt(key.slice(0, separator), 10);
  const label = key.slice(separator + 1);
  if (Number.isInteger(index) && labels[index] === label) return index;
  const moved = labels.indexOf(label);
  return moved >= 0 ? moved : undefined;
}

/** Read a label out of a host list entry, whatever field it keeps it in. */
export function labelOf(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return String(entry);
  const record = entry as Record<string, unknown>;
  for (const field of ["label", "value", "name", "title", "text"]) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return JSON.stringify(record).slice(0, 60);
}

export function descriptionOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  for (const field of ["description", "hint", "detail", "doc", "docs"]) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value.replace(/\s+/g, " ").trim();
  }
  return undefined;
}

/** The class name, for whitelists; host may load its own copy of a class. */
export function constructorName(value: unknown): string {
  const ctor = (value as { constructor?: { name?: string } })?.constructor;
  return typeof ctor?.name === "string" ? ctor.name : "";
}

/** Walk the cursor the way a user would: one arrow key per step. */
export function moveCursor(sendKey: (name: string) => boolean, from: number, to: number): boolean {
  const steps = Math.abs(to - from);
  if (steps === 0) return true;
  const name = to < from ? "up" : "down";
  for (let step = 0; step < steps; step += 1) {
    if (!sendKey(name)) return false;
  }
  return true;
}

/**
 * Move to `target` and press Enter, the two steps every list-style dialog
 * performs. Returns false when the component refuses the keys, which the
 * Broker reports instead of pretending the choice landed.
 */
export function selectRow(
  sendKey: (name: string) => boolean,
  cursor: number,
  target: number,
  submitKey = "enter",
): boolean {
  if (!moveCursor(sendKey, cursor, target)) return false;
  return sendKey(submitKey);
}
