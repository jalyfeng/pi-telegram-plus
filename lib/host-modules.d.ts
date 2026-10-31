declare module "@oh-my-pi/pi-utils" {
  export const VERSION: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/modes/interactive-mode" {
  export const InteractiveMode: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller" {
  export const ExtensionUiController: unknown;
}

declare module "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry" {
  export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<{
    name: string;
    description?: string;
    aliases?: readonly string[];
  }>;
}
