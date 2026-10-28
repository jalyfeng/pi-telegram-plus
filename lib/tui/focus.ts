/**
 * FocusTracker (stage 2): the host's focus is the authority for "is a dialog
 * open?", for what that dialog *means*, and for the command scope end
 * condition. It only observes; DialogBroker is the consumer that acts.
 *
 * Three things happen here (§4.1):
 * - focus events: `ui.setFocus` / `setFocusInternal` hooks, plus a one-second
 *   verification read for the input path that bypasses both;
 * - semantic association: the entry hooks (`entry.ts`) push an `EntryInfo`
 *   while a dialog is being created, which is matched to the focused component
 *   here — no time windows;
 * - local input marking: the editor's own `handleInput` is wrapped once so a
 *   keystroke in the terminal is distinguishable from anything the plugin does.
 */
import { onHostState, hookMethod, hookOwnedMethod, isHostObject, type HostState } from "./host.ts";
import { removeOwnerHooks } from "./hooks.ts";
import { hookEntryMethods, insideEntryCall, PI_ENTRY_SPECS, UI_CONTEXT_SPECS, OMP_ENTRY_SPECS, type EntrySink } from "./entry.ts";
import { installRace, takePendingRace } from "./race.ts";
import { findShape, isControlShape, isEditorShape, isFilteredList, isInputShape, isReadOnlyPanel, isSelectList, isSettingsList } from "./find-shape.ts";
import { describesDialog, describesLoginSheet } from "./adapters/tsp.ts";
import type { EntryInfo } from "./model.ts";
import { log } from "../logger.ts";
import { currentCommandScope } from "./command-context.ts";
import type { CommandScope } from "./origin.ts";

const focusLog = log.child("tui-focus");

export type FocusKind = "editor" | "inert" | "progress" | "dialog" | "unknown";

export type FocusInfo = {
  kind: FocusKind;
  component?: Record<string, unknown>;
  /** The container the dialog was mounted into; used to find titles only. */
  root?: Record<string, unknown>;
  /** How the value was obtained; useful in logs and tests. */
  source: "event" | "getter" | "field" | "none";
  /** The command whose call chain made the host focus this component, when the focus
   * came from the host's own `setFocus` call inside that chain (§4.3 rule 1). */
  commandScope?: CommandScope;
};

type FocusListener = (info: FocusInfo) => void;
type OpenListener = (component: Record<string, unknown>, info: FocusInfo) => void;
type CloseListener = (component: Record<string, unknown>, info: FocusInfo) => void;
/** One open dialog's entry, kept until the host's call settles. */
type PendingEntry = { info: EntryInfo; at: number };

/** How many verification reads must agree before a silent focus change counts. */
const VERIFY_SAMPLES = 2;
const VERIFY_MS = 1_000;
const MAX_PENDING_ENTRIES = 8;
const ENTRY_TTL_MS = 5_000;
/** How long focus must stay off a dialog before it counts as closed (§4.1.3). */
const FOCUS_CLOSE_GRACE_MS = 250;
/** How long a panel entry waits for the component that takes focus right after its
 *  entry call returns (T3.1). */
const PANEL_HANDOFF_MS = 1_000;

function ctorName(value: Record<string, unknown>): string {
  try {
    return Object.getPrototypeOf(value)?.constructor?.name ?? "";
  } catch {
    return "";
  }
}

/** pi wraps the focus argument in `{component, overlayFocusRestore}`. */
function unwrapFocus(value: unknown): Record<string, unknown> | undefined {
  if (!isHostObject(value)) return undefined;
  const wrapped = value.component;
  if (isHostObject(wrapped)) return wrapped;
  return value;
}
/** Depth-limited containment check used by the mount lookup. */
function containsComponent(container: Record<string, unknown>, component: object, depth = 3): boolean {
  if (depth <= 0) return false;
  const children = container.children;
  if (!Array.isArray(children)) return false;
  for (const child of children) {
    if (child === component) return true;
    if (isHostObject(child) && containsComponent(child, component, depth - 1)) return true;
  }
  return false;
}


const DIALOG_NAME = /(Selector|Dialog|Input|Editor|Panel|List|Question|Permission|Approval|Confirm|Settings|Menu|Wizard|Form|Prompt)/i;

export class FocusTracker {
  private info: FocusInfo = { kind: "unknown", source: "none" };
  private editor?: Record<string, unknown>;
  private readonly listeners = new Set<FocusListener>();
  private readonly openedListeners = new Set<OpenListener>();
  private readonly closedListeners = new Set<CloseListener>();
  private readonly attached = new WeakSet<object>();
  private readonly entryByComponent = new WeakMap<object, EntryInfo>();
  /** Entries recorded by the entry hooks, innermost last (§4.1.2). */
  private pending: PendingEntry[] = [];
  /** The pending entry a component has already claimed (§4.1.2). */
  private boundEntry?: PendingEntry;
  /** A panel entry just retired by its own call, waiting for the component that
   *  takes focus next - OMP's `/agents` dashboard returns before it gets focus. */
  private recentPanel?: { info: EntryInfo; until: number };
  /** A dialog whose close is waiting to be confirmed by the next focus event. */
  private closeGrace?: { component: Record<string, unknown>; timer: NodeJS.Timeout };
  private readonly localInput = new Map<object, number>();
  private verifyTarget?: Record<string, unknown>;
  private verifyCount = 0;
  /** The host objects the entry hooks were last installed on (H-3, §0.2 #19). A tick
   *  re-installs only when one of them has changed identity. */
  private hookedTargets?: { ui: unknown; toolUi: unknown; mode: unknown };
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onHostState((state) => this.attach(state));
    this.timer = setInterval(() => this.verify(), VERIFY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    this.cancelGrace();
    removeOwnerHooks(this);
    this.hookedTargets = undefined;
  }

  current(): FocusInfo {
    return this.info;
  }

  /**
   * One live read of the focused object, compared with the recorded focus (§4.1.3). The Broker
   * calls this before it judges a Telegram tap and right after the host call that tap made: a
   * selector hands focus to the next list inside its own Enter, and the two-sample tick would
   * still report the old dialog for seconds. A mismatch is a focus change now.
   */
  validate(): void {
    const ui = this.lastState?.ui;
    if (!ui) return;
    const read = this.readCurrent(ui);
    if (!read || read === this.info.component) return;
    this.verifyTarget = undefined;
    this.verifyCount = 0;
    this.update(read, "getter");
  }

  isEditor(): boolean {
    return this.info.kind === "editor" || this.info.kind === "unknown";
  }

  isDialog(): boolean {
    return this.info.kind === "dialog" || this.info.kind === "progress";
  }

  onChange(listener: FocusListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onOpened(listener: OpenListener): () => void {
    this.openedListeners.add(listener);
    return () => { this.openedListeners.delete(listener); };
  }

  onClosed(listener: CloseListener): () => void {
    this.closedListeners.add(listener);
    return () => { this.closedListeners.delete(listener); };
  }

  // --- entry association (§4.1.2) -------------------------------------------

  /**
   * Record a pending entry. `nested` marks a call running inside another entry
   * call; a nested entry enriches the top instead of becoming its own record, and
   * returns nothing so the hook does not retire someone else's entry.
   */
  pushEntry(info: EntryInfo, nested = false): PendingEntry | undefined {
    const top = this.pending[this.pending.length - 1];
    if (nested && top && Date.now() - top.at < ENTRY_TTL_MS) {
      // Nested entry (confirm → selector, tool context → mode delegate):
      // enrich the outer entry, never change its kind.
      if (info.options && !top.info.options) top.info.options = info.options;
      if (info.questions && !top.info.questions) top.info.questions = info.questions;
      if (info.secret) top.info.secret = true;
      if (info.approval && !top.info.approval) top.info.approval = info.approval;
      return undefined;
    }
    // The race wrapper of this very call registered its handle before the
    // entry wrapper ran; take it so the record carries the answer path (§4.12).
    const race = takePendingRace();
    if (race) info.race = race;
    const record: PendingEntry = { info, at: Date.now() };
    this.pending.push(record);
    // A new question is a new dialog: let its own component claim the entry.
    this.boundEntry = undefined;
    while (this.pending.length > MAX_PENDING_ENTRIES) {
      const dropped = this.pending.shift();
      if (dropped === this.boundEntry) this.boundEntry = undefined;
    }
    return record;
  }

  /** Retire one record: the dialog's own promise settles, not the call stack. */
  popEntry(record: object | undefined): void {
    if (!record) return;
    const index = this.pending.indexOf(record as PendingEntry);
    if (index < 0) return;
    const [removed] = this.pending.splice(index, 1);
    // A read-only dashboard's entry call returns before the dashboard takes focus,
    // so keep its panel entry for the component that gets focus next (T3.1).
    if (removed.info.kind === "panel" && removed !== this.boundEntry) {
      this.recentPanel = { info: removed.info, until: Date.now() + PANEL_HANDOFF_MS };
    }
    if (removed === this.boundEntry) this.boundEntry = undefined;
  }

  /**
   * The semantic entry of a component: recorded first, then the entry whose dialog
   * is still open. A pending entry lives exactly as long as the host's call, and
   * only the component that first claimed it - or the wrapper holding that component -
   * may use it: a loader that takes focus meanwhile is not the thing the user is
   * being asked about.
   */
  entryFor(component: Record<string, unknown>): EntryInfo | undefined {
    const recorded = this.entryByComponent.get(component);
    if (recorded) return recorded;
    const top = this.pending[this.pending.length - 1];
    if (!top) return undefined;
    if (this.boundEntry === top) {
      // OMP hands focus to the overlay wrapper a beat after the dialog inside it
      // claimed the entry, and the wrapper is what receives the keys afterwards: it
      // answers for the same question, so long as the claimant really sits inside it.
      return this.holdsClaimant(component, top.info) ? top.info : undefined;
    }
    this.entryByComponent.set(component, top.info);
    this.boundEntry = top;
    return top.info;
  }

  /** True when a component just below `root` already claimed `info`. */
  private holdsClaimant(root: Record<string, unknown>, info: EntryInfo): boolean {
    const seen = new Set<unknown>([root]);
    const stack: { node: Record<string, unknown>; depth: number }[] = [{ node: root, depth: 0 }];
    while (stack.length > 0) {
      const { node, depth } = stack.pop() as { node: Record<string, unknown>; depth: number };
      if (depth > 0 && this.entryByComponent.get(node) === info) return true;
      // Containers hold their content under one of these; nothing else is walked, so
      // no host getter runs on the way.
      if (depth >= 2) continue;
      for (const key of ["children", "component", "child", "content", "body"]) {
        const value = node[key];
        for (const child of Array.isArray(value) ? value : [value]) {
          if (!isHostObject(child) || seen.has(child)) continue;
          seen.add(child);
          stack.push({ node: child, depth: depth + 1 });
        }
      }
    }
    return false;
  }

  /** Records an entry for a component produced outside a focus event. */
  bindEntry(component: object, info: EntryInfo): void {
    this.entryByComponent.set(component, info);
  }

  // --- local input marking (§4.1.3 / §4.2.4) --------------------------------

  /** True once per burst: the terminal user typed into this component. */
  consumeLocalInput(component: Record<string, unknown>): boolean {
    const stamped = this.localInput.get(component);
    if (stamped === undefined) return false;
    this.localInput.delete(component);
    // Two keystrokes within a second are one burst of typing.
    return Date.now() - stamped > 0;
  }

  private markLocalInput(component: Record<string, unknown>): void {
    this.localInput.set(component, Date.now());
  }

  private watchEditor(component: Record<string, unknown>): void {
    hookMethod(component, "handleInput", "focus-local-input", () => this.markLocalInput(component), undefined, this);
  }

  // --- observation -----------------------------------------------------------

  private attach(state: HostState): void {
    this.lastState = state;
    this.editor = state.editor ?? state.defaultEditor;
    const ui = state.ui;
    if (this.editor) this.watchEditor(this.editor);
    if (!ui) return;
    this.attachUi(ui);
    this.attachEntryHooks(state);
    const getter = this.readCurrent(ui);
    if (getter) this.update(getter, "getter");
    else if (this.info.source === "none" && this.editor) this.update(this.editor, "field");
  }

  private attachUi(ui: Record<string, unknown>): void {
    const alreadyAttached = this.attached.has(ui);
    if (!alreadyAttached) {
      this.attached.add(ui);
      // `ui` may be pi's reference proxy: the hooks go on the prototype that
      // owns each method, and receive the real TUI as `self`.
      for (const name of ["setFocus", "setFocusInternal"]) {
        hookOwnedMethod(ui, name, "focus-tracker", (args) => {
          const component = unwrapFocus(args[0]);
          if (component) this.update(component, "event", currentCommandScope());
        }, undefined, this);
      }
      // Overlay swaps that never reach `setFocus` are caught by the tick.
      for (const name of ["showOverlay", "hideOverlay"]) {
        hookOwnedMethod(ui, name, "focus-tracker-overlay", undefined, (_args, _result, self) => {
          const current = isHostObject(self) ? this.readCurrent(self) : undefined;
          if (current) this.update(current, "getter");
        }, this);
      }
    }
  }

  /** Install the entry-method hooks for this host (§4.1.2). */
  private attachEntryHooks(state: HostState): void {
    const ui = state.ui;
    const runner = (state.session as Record<string, unknown> | undefined)?.extensionRunner as
      | { getUIContext?: () => unknown }
      | undefined;
    const toolUi = this.readUiContext(runner);
    const mode = state.mode;
    // H-3: the tick only compares host object identities. Unchanged objects mean
    // every hook below is already installed on them, so there is nothing to do.
    const hooked = this.hookedTargets;
    if (hooked && hooked.ui === ui && hooked.toolUi === toolUi && hooked.mode === mode) return;
    this.hookedTargets = { ui, toolUi, mode };
    const sink: EntrySink = {
      push: (info, nested) => this.pushEntry(info, nested),
      pop: (token) => this.popEntry(token),
      bind: (component, info) => this.bindEntry(component, info),
    };
    if (ui) hookEntryMethods(ui, UI_CONTEXT_SPECS, sink, state.host === "omp" ? "omp" : "pi", this);
    if (toolUi && toolUi !== ui) hookEntryMethods(toolUi, UI_CONTEXT_SPECS, sink, state.host === "omp" ? "omp" : "pi", this);
    // The race wrapper goes on outside the entry wrapper: it registers its
    // handle before that wrapper pushes, so the entry above can take it (§4.12).
    // `confirm` and `input` are wrapped too: pi's `confirm` draws through the
    // selector, so only the outer call's handle can answer it.
    // `editor`/`approve`/`askDialog` are OMP-only: pi 1.4.0's `editor(title,
    // prefill)` takes no options object, so an abort signal could not close its
    // dialog and the terminal would be left holding an unmanaged editor; pi has
    // no `approve` or `askDialog` anyway. OMP's `askDialog(questions,
    // dialogOptions?)` takes its options second, and it lives on the tool UI
    // context only, which is where the loop below installs. `installRace` would
    // skip a missing method regardless.
    const racedMethods = state.host === "omp"
      ? ["select", "confirm", "input", "editor", "approve", "askDialog"] as const
      : ["select", "confirm", "input"] as const;
    if (toolUi) for (const method of racedMethods) installRace(toolUi, method, this);
    if (state.host === "omp") hookEntryMethods(state.mode, OMP_ENTRY_SPECS, sink, "omp", this);
    if (state.host === "pi" && state.mode) {
      hookEntryMethods(state.mode, PI_ENTRY_SPECS, sink, "pi", this);
      this.hookPiDialogStack(state.mode);
    }
  }

  /**
   * pi 1.4.0 routes every extension dialog through the mode's
   * `pushExtensionDialog(component, blocked)`. A synchronous push runs inside
   * the hooked `showExtension*` call, so the innermost pending entry is this
   * dialog's: bind it to the component, so the dialog keeps its meaning even
   * when focus is only noticed on a later tick. `blocked` ({ kind, message })
   * is logged as reported. A push outside any entry call is the custom
   * factory's async one - already bound by the factory wrapper, so it must
   * not steal an older open dialog's entry.
   */
  hookPiDialogStack(mode: Record<string, unknown>): void {
    hookMethod(mode, "pushExtensionDialog", "pi-extension-dialog", (args) => {
      focusLog.debug("pi extension dialog pushed", { blocked: args[1] });
      const component = args[0];
      if (!insideEntryCall() || !isHostObject(component)) return;
      const top = this.pending[this.pending.length - 1];
      if (top) this.bindEntry(component, top.info);
    }, undefined, this);
  }

  private readUiContext(runner?: { getUIContext?: () => unknown }): Record<string, unknown> | undefined {
    const getUi = runner?.getUIContext;
    if (typeof getUi !== "function") return undefined;
    try {
      let value = getUi.call(runner) as Record<string, unknown> | undefined;
      // Never patch our own routed UI - unwrap to the host context underneath it.
      // Without this the entry hooks are skipped whenever a Telegram swap happens to be
      // installed at hook time, and every dialog afterwards reports as unsupported.
      for (let depth = 0; value?.__piTelegramPlusRoutedUi === true && depth < 8; depth += 1) {
        const base = value.__piTelegramPlusRoutedBaseUi;
        value = base && typeof base === "object" ? (base as Record<string, unknown>) : undefined;
      }
      return isHostObject(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private readCurrent(ui: Record<string, unknown>): Record<string, unknown> | undefined {
    for (const name of ["getFocused", "getFocus"]) {
      const getter = ui[name];
      if (typeof getter !== "function") continue;
      try {
        const value = unwrapFocus((getter as (this: unknown) => unknown).call(ui));
        if (value) return value;
      } catch {
        // The focus tree may not be initialized yet.
      }
    }
    const field = ui.focusedComponent ?? ui.focused;
    return isHostObject(field) ? field : undefined;
  }

  /**
   * Verification path (§4.1.3): pi's `focusedComponent` lags one event, so a
   * single disagreeing read is not trusted. Two consecutive reads of the same
   * other component mean the change really happened without an event.
   */
  private verify(): void {
    const ui = this.lastState?.ui;
    if (!ui) return;
    // A progress panel can gain its input after it was classified (pi's login sheet mounts the key
    // prompt after the sign-in step): re-classify the same object each tick and report the change.
    const held = this.info.component;
    if (this.info.kind === "progress" && held && this.classify(held) === "dialog") {
      this.update(held, "getter");
    }
    // The runner's UI context is a moving target: a Telegram swap can be what is
    // installed when the hooks first run. Re-check every tick that the host context
    // underneath it is hooked - `hookEntryMethods` skips what it already wrapped.
    this.attachEntryHooks(this.lastState!);
    const read = this.readCurrent(ui);
    if (!read || read === this.info.component) {
      this.verifyTarget = undefined;
      this.verifyCount = 0;
      return;
    }
    if (this.verifyTarget === read) this.verifyCount += 1;
    else {
      this.verifyTarget = read;
      this.verifyCount = 1;
    }
    // Two agreeing reads, so a one-event-stale reading never closes a dialog.
    if (this.verifyCount < VERIFY_SAMPLES) return;
    this.verifyTarget = undefined;
    this.verifyCount = 0;
    this.update(read, "getter");
  }


  private lastState?: HostState;

  private update(component: Record<string, unknown>, source: FocusInfo["source"], commandScope?: CommandScope): void {
    const previous = this.info;
    // A read-only dashboard returns from its entry call before it takes focus (OMP
    // `showAgentsDashboard`): the next non-editor component to take focus within a
    // second is that dashboard, so it inherits the panel entry (T3.1).
    const recent = this.recentPanel;
    if (recent) {
      if (Date.now() > recent.until) this.recentPanel = undefined;
      else if (!this.isEditorComponent(component) && !this.entryByComponent.has(component)) {
        this.entryByComponent.set(component, recent.info);
        this.recentPanel = undefined;
      }
    }

    const kind = this.classify(component);
    if (previous.kind === kind && previous.component === component) return;
    // A host that redraws an open dialog can drop focus to the editor for one
    // frame and take it back. Retiring on the dip would close the Telegram dialog
    // and hand its keys to the screen mirror, so a return to the editor is
    // confirmed over a short window instead (§4.1.3).
    if (this.closeGrace?.component === component) this.cancelGrace();
    const root = this.findRoot(component);
    this.info = { kind, component, root, source, commandScope };
    focusLog.debug("focus changed", { kind, source, ctor: ctorName(component) });
    for (const listener of this.listeners) {
      try { listener(this.info); } catch (err) { focusLog.debug("focus listener failed", { err }); }
    }
    // Closing the old dialog is reported before opening the new one so the
    // Broker can retire a session even when focus jumps straight to a dialog.
    const previousDialog = previous.component && (previous.kind === "dialog" || previous.kind === "progress") ? previous.component : undefined;
    if (previousDialog && previousDialog !== component) {
      if (kind === "editor") {
        if (this.closeGrace?.component !== previousDialog) {
          this.cancelGrace();
          const closing = previousDialog;
          const timer = setTimeout(() => {
            this.closeGrace = undefined;
            this.reportClosed(closing, previous);
          }, FOCUS_CLOSE_GRACE_MS);
          timer.unref?.();
          this.closeGrace = { component: closing, timer };
        }
      } else {
        // Straight into another dialog: the old one is gone, whatever the frame said.
        this.cancelGrace();
        this.reportClosed(previousDialog, previous);
      }
    }
    if (kind === "dialog" || kind === "progress") {
      for (const listener of this.openedListeners) {
        try { listener(component, this.info); } catch (err) { focusLog.debug("opened listener failed", { err }); }
      }
    }
  }

  private reportClosed(component: Record<string, unknown>, info: FocusInfo): void {
    for (const listener of this.closedListeners) {
      try { listener(component, info); } catch (err) { focusLog.debug("closed listener failed", { err }); }
    }
  }

  private cancelGrace(): void {
    if (!this.closeGrace) return;
    clearTimeout(this.closeGrace.timer);
    this.closeGrace = undefined;
  }

  /** Where the dialog was mounted: editor container, overlay, or chat feed. */
  private findRoot(component: Record<string, unknown>): Record<string, unknown> | undefined {
    const state = this.lastState;
    if (!state) return undefined;
    const editorContainer = state.mode ? (state.mode as Record<string, unknown>).editorContainer : undefined;
    const overlayStack = state.ui?.overlayStack;
    const overlay = Array.isArray(overlayStack) && overlayStack.length > 0 ? overlayStack[overlayStack.length - 1] : undefined;
    for (const candidate of [editorContainer, overlay, state.chat]) {
      if (!isHostObject(candidate)) continue;
      if (candidate === component || containsComponent(candidate, component)) return candidate;
    }
    return undefined;
  }

  /** True for the editor itself or the text input nested inside it. */
  private isEditorComponent(component: Record<string, unknown>): boolean {
    const editor = this.editor;
    if (!editor) return false;
    if (component === editor) return true;
    const editorInner = editor.editor;
    return isHostObject(editorInner) && component === editorInner;
  }

  private classify(component: Record<string, unknown>): FocusKind {
    if (this.isEditorComponent(component)) return "editor";
    // Explicitly bound to a panel entry: a dialog whatever its shape (T3.1).
    if (this.entryByComponent.get(component)?.kind === "panel") return "dialog";
    if (typeof component.render !== "function") return "inert";
    if (typeof component.handleInput !== "function") {
      // A loader or a read-only view still owns focus, so chat text must not
      // fall through to the editor: treat it as a dialog with only a way out.
      return isReadOnlyPanel(component) ? "progress" : "inert";
    }
    const interactive: Record<string, unknown> = component;
    if (isSelectList(interactive) || isSettingsList(interactive) || isFilteredList(interactive)
      || isInputShape(interactive) || isEditorShape(interactive)) {
      return "dialog";
    }
    const name = ctorName(component);
    // OMP's pickers, settings pages and login prompts carry `signal`/`abortController`
    // like a loader does, so the rule below would file them under "progress" and the
    // broker would never open a session. A component that describes itself as a
    // picker, a prefs page, a text prompt, or a login sheet (including the link-only form
    // that has no input) is a dialog the TSP adapters can drive (§4.11.3). OMP only: pi has
    // no `describe`, and its loaders keep matching below.
    if (this.lastState?.host === "omp" && (describesDialog(component) || describesLoginSheet(component))) return "dialog";
    // A loader is progress. A component that carries a signal but still holds a live list or input
    // field is a prompt the user answers (pi's login sheet): the plan's progress rule is "no list or
    // input field at all" (§4.1.3), so only the field-less case is progress.
    const carriesSignal = component.signal !== undefined || component.abortController !== undefined;
    const holdsControl = findShape(component, isControlShape, 2) !== undefined;
    if (name.endsWith("Loader") || (carriesSignal && !holdsControl)) {
      return "progress";
    }
    // The host asked the user something and this component receives the keys, so it is a
    // dialog whatever it is shaped like. Hosts that keep a dialog's rows in private fields
    // match none of the shape checks above and their class names are minified, which used to
    // land a real dialog on "progress" (§4.6.5). This runs after the loader checks on
    // purpose: asking costs a claim on the pending entry, and the spinner that merely holds
    // the keyboard so Esc can interrupt must never take it.
    if (this.entryFor(component)) return "dialog";
    if (DIALOG_NAME.test(name)) return "dialog";
    if (typeof component.options === "string" || Array.isArray(component.options)) return "dialog";
    if (typeof component.selectedIndex === "number") return "dialog";
    // A list or input somewhere inside: the user answers it, so it is a dialog.
    if (holdsControl) return "dialog";
    // Keys but no list, no input: a status/progress widget, not a dialog.
    return "progress";
  }
}