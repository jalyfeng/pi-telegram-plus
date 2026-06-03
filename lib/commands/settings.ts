import type { CommandRegistry } from "./register.ts";
import type { CapturedAgentSession } from "../types.ts";

export function registerSettingsCommands(
  registry: CommandRegistry,
  deps: { getSession: () => CapturedAgentSession | undefined },
): void {
  registry.registerCommand("settings", {
    description: "View or change common settings",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const session = deps.getSession();
      if (!session) {
        ui.notify("No active session", "error");
        return;
      }

      const s = session.settingsManager;
      const options = [
        `Hide thinking: ${s.getHideThinkingBlock() ? "on" : "off"}`,
        `Compaction: ${s.getCompactionEnabled() ? "on" : "off"}`,
        `Retry: ${s.getRetryEnabled() ? "on" : "off"}`,
        `Show images: ${s.getShowImages() ? "on" : "off"}`,
        `Terminal progress: ${s.getShowTerminalProgress() ? "on" : "off"}`,
        `Quiet startup: ${s.getQuietStartup() ? "on" : "off"}`,
        `Theme: ${s.getTheme() ?? "default"}`,
        `Default thinking: ${s.getDefaultThinkingLevel() ?? "unset"}`,
        `Block images: ${s.getBlockImages() ? "on" : "off"}`,
        `Image auto resize: ${s.getImageAutoResize() ? "on" : "off"}`,
        `Clear on shrink: ${s.getClearOnShrink() ? "on" : "off"}`,
        `Double escape: ${s.getDoubleEscapeAction()}`,
        `Tree filter: ${s.getTreeFilterMode()}`,
        `Shell prefix: ${s.getShellCommandPrefix() ?? "unset"}`,
      ];

      const choice = await ui.select("Settings", options);
      if (!choice) return;

      if (choice.startsWith("Hide thinking")) {
        const next = !s.getHideThinkingBlock();
        s.setHideThinkingBlock(next);
        ui.notify(`Hide thinking: ${next ? "on" : "off"}`, "info");
        return;
      }
      if (choice.startsWith("Compaction")) {
        const next = !s.getCompactionEnabled();
        s.setCompactionEnabled(next);
        ui.notify(`Compaction: ${next ? "on" : "off"}`, "info");
        return;
      }
      if (choice.startsWith("Retry")) {
        const next = !s.getRetryEnabled();
        s.setRetryEnabled(next);
        ui.notify(`Retry: ${next ? "on" : "off"}`, "info");
        return;
      }
      if (choice.startsWith("Show images")) {
        const next = !s.getShowImages();
        s.setShowImages(next);
        ui.notify(`Show images: ${next ? "on" : "off"}`, "info");
        return;
      }
      if (choice.startsWith("Terminal progress")) {
        const next = !s.getShowTerminalProgress();
        s.setShowTerminalProgress(next);
        ui.notify(`Terminal progress: ${next ? "on" : "off"}`, "info");
        return;
      }
      if (choice.startsWith("Quiet startup")) {
        const next = !s.getQuietStartup();
        s.setQuietStartup(next);
        ui.notify(`Quiet startup: ${next ? "on" : "off"}`, "info");
        return;
      }
      if (choice.startsWith("Theme")) {
        const theme = await ui.input("Theme name", s.getTheme() ?? "dark");
        if (!theme) return;
        s.setTheme(theme.trim());
        ui.notify(`Theme set: ${theme.trim()}. Use /reload to apply.`, "info");
        return;
      }
      if (choice.startsWith("Default thinking")) {
        const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
        const level = await ui.select("Default thinking", levels);
        if (!level) return;
        s.setDefaultThinkingLevel(level as any);
        ui.notify(`Default thinking: ${level}`, "info");
        return;
      }
      if (choice.startsWith("Block images")) {
        const next = !s.getBlockImages();
        s.setBlockImages(next);
        ui.notify(`Block images: ${next ? "on" : "off"}`, "info");
        return;
      }
      if (choice.startsWith("Image auto resize")) {
        const next = !s.getImageAutoResize();
        s.setImageAutoResize(next);
        ui.notify(`Image auto resize: ${next ? "on" : "off"}`, "info");
        return;
      }
      if (choice.startsWith("Clear on shrink")) {
        const next = !s.getClearOnShrink();
        s.setClearOnShrink(next);
        ui.notify(`Clear on shrink: ${next ? "on" : "off"}`, "info");
        return;
      }
      if (choice.startsWith("Double escape")) {
        const value = await ui.select("Double escape action", ["fork", "tree", "none"]);
        if (!value) return;
        s.setDoubleEscapeAction(value as any);
        ui.notify(`Double escape: ${value}`, "info");
        return;
      }
      if (choice.startsWith("Tree filter")) {
        const value = await ui.select("Tree filter", ["default", "no-tools", "user-only", "labeled-only", "all"]);
        if (!value) return;
        s.setTreeFilterMode(value as any);
        ui.notify(`Tree filter: ${value}`, "info");
        return;
      }
      if (choice.startsWith("Shell prefix")) {
        const value = await ui.input("Shell command prefix", s.getShellCommandPrefix() ?? "!");
        s.setShellCommandPrefix(value?.trim() || undefined);
        ui.notify(`Shell prefix: ${value?.trim() || "unset"}`, "info");
      }
    },
  });
}
