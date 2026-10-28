/**
 * Adapter registry (§4.6.1).
 *
 * Ordered by specificity: the first `detect` that says yes owns the dialog, and
 * a dialog is only ever handed to one adapter. `unsupported` matches everything,
 * so it sits last and only ever sees what nothing else claimed.
 *
 * A `detect` that throws is treated as "no": a probe against an unknown host
 * build must not take the dialog down with it.
 */
import type { AdapterContext, DialogAdapter } from "../model.ts";
import { askDialogAdapter } from "./ask.ts";
import { approvalAdapter } from "./approval.ts";
import { customGoalAdapter } from "./goal.ts";
import { extensionEditorAdapter, extensionInputAdapter, extensionSelectAdapter } from "./extension.ts";
import { describedPanelAdapter, infoPanelAdapter, unsupportedAdapter } from "./panel.ts";
import { piListAdapter, piSessionAdapter, piTreeAdapter } from "./pi-lists.ts";
import { piLoginAdapter } from "./pi-login.ts";
import { piSettingsAdapter } from "./pi-settings.ts";
import { tspInputAdapter, tspLoginAdapter, tspPickerAdapter, tspPrefsAdapter } from "./tsp.ts";

export const DIALOG_ADAPTERS: DialogAdapter[] = [
  // OMP's own semantic descriptions beat any frame reading, on OMP only.
  tspPickerAdapter,
  tspPrefsAdapter,
  // OMP's login sheet beats the generic text prompt it may also contain.
  tspLoginAdapter,
  tspInputAdapter,
  askDialogAdapter,
  approvalAdapter,
  customGoalAdapter,
  piLoginAdapter,
  extensionInputAdapter,
  extensionEditorAdapter,
  // pi's own selector fields beat the generic `filteredRows` guess.
  piListAdapter,
  piSessionAdapter,
  piSettingsAdapter,
  piTreeAdapter,
  extensionSelectAdapter,
  // OMP text panels described as text + buttons; before the frame-less info fallback.
  describedPanelAdapter,
  infoPanelAdapter,
  unsupportedAdapter,
];

export function pickAdapter(component: object, ctx: AdapterContext): DialogAdapter | undefined {
  for (const adapter of DIALOG_ADAPTERS) {
    try {
      if (adapter.detect(component, ctx)) return adapter;
    } catch {
      // Fall through to the next, and eventually to the unsupported fallback.
    }
  }
  return undefined;
}

export {
  approvalAdapter,
  askDialogAdapter,
  customGoalAdapter,
  describedPanelAdapter,
  extensionEditorAdapter,
  extensionInputAdapter,
  extensionSelectAdapter,
  infoPanelAdapter,
  piListAdapter,
  piLoginAdapter,
  piSessionAdapter,
  piSettingsAdapter,
  piTreeAdapter,
  tspInputAdapter,
  tspLoginAdapter,
  tspPickerAdapter,
  tspPrefsAdapter,
  unsupportedAdapter,
};
