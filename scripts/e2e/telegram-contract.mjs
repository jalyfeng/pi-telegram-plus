/**
 * Telegram Bot API payload contract checks.
 *
 * The mock Bot API accepts anything, so a green acceptance run only proves the
 * plugin called the API — not that the real API would accept the payload. These
 * are the limits the real service enforces and answers with 400 otherwise:
 * text/caption length, HTML entity rules, inline-keyboard shape and
 * callback_data size, plus setMyCommands naming rules.
 *
 * Deliberately strict: an unknown tag or a stray "<" is a violation, because
 * Telegram rejects the whole message in that case.
 */

const MESSAGE_TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const CALLBACK_DATA_LIMIT = 64;
const BUTTONS_PER_ROW_LIMIT = 8;
const BUTTONS_TOTAL_LIMIT = 100;
const COMMAND_LEN_LIMIT = 32;
const COMMAND_DESC_LIMIT = 256;
const MAX_COMMANDS = 100;

// https://core.telegram.org/bots/api#html-style
const ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre",
  "blockquote", "tg-spoiler", "span", "tg-emoji",
]);
const VOID_TAGS = new Set(["br"]);
const ENTITY = /^&(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/;

const units = (value) => String(value).length; // Telegram counts UTF-16 code units

function validateHtml(text) {
  const problems = [];
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "<") {
      const close = text.indexOf(">", index);
      if (close === -1) {
        problems.push(`unterminated tag at ${index}`);
        break;
      }
      const raw = text.slice(index + 1, close);
      const match = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*)$/.exec(raw);
      if (!match) {
        problems.push(`stray "<" at ${index}: ${raw.slice(0, 20)}`);
        index = close + 1;
        continue;
      }
      const [, slash, name, rest] = match;
      const tag = name.toLowerCase();
      if (!ALLOWED_TAGS.has(tag) && !VOID_TAGS.has(tag)) {
        problems.push(`unsupported tag <${name}>`);
      }
      if (slash) {
        if (stack.length === 0) problems.push(`closing </${tag}> without opening`);
        else {
          const open = stack.pop();
          if (open !== tag) problems.push(`</${tag}> closes <${open}>`);
        }
      } else if (!VOID_TAGS.has(tag)) {
        // Telegram allows exactly one nesting inside <pre>: a <code> element as
        // its direct child (optionally with a language-* class). Everything
        // else nested inside <pre> or <code> is rejected.
        const parent = stack[stack.length - 1];
        const codeInPre = tag === "code" && parent === "pre";
        if (!codeInPre && (parent === "pre" || parent === "code")) {
          problems.push(`<${tag}> nested inside <${parent}>`);
        }
        if (rest.trim()) {
          const allowed =
            (tag === "a" && /^\s+href="[^"]*"\s*$/.test(rest)) ||
            (tag === "span" && /^\s+class="tg-spoiler"\s*$/.test(rest)) ||
            (tag === "tg-emoji" && /^\s+emoji-id="\d+"\s*$/.test(rest)) ||
            (tag === "code" && /^\s+class="language-[a-zA-Z0-9+#._-]+"\s*$/.test(rest)) ||
            (tag === "blockquote" && /^\s+expandable\s*$/.test(rest));
          if (!allowed) problems.push(`<${tag}> has unsupported attributes: ${rest.trim().slice(0, 30)}`);
        }
        stack.push(tag);
      }
      index = close + 1;
      continue;
    }
    if (char === "&") {
      if (!ENTITY.test(text.slice(index))) problems.push(`bare "&" at ${index} (must be &amp;)`);
    }
    index += 1;
  }
  for (const tag of stack) problems.push(`unclosed <${tag}>`);
  return problems;
}

function validateKeyboard(markup) {
  const problems = [];
  const keyboard = markup?.inline_keyboard;
  if (!keyboard) return problems;
  if (!Array.isArray(keyboard)) return ["inline_keyboard is not an array"];
  let total = 0;
  keyboard.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      problems.push(`row ${rowIndex} is not an array`);
      return;
    }
    if (row.length > BUTTONS_PER_ROW_LIMIT) problems.push(`row ${rowIndex} has ${row.length} buttons (max ${BUTTONS_PER_ROW_LIMIT})`);
    for (const button of row) {
      total += 1;
      if (typeof button?.text !== "string" || button.text.length === 0) {
        problems.push(`row ${rowIndex}: button without text`);
        continue;
      }
      const targets = ["callback_data", "url", "web_app", "switch_inline_query", "pay"].filter((key) => button[key] !== undefined);
      if (targets.length !== 1) problems.push(`row ${rowIndex}: button "${button.text.slice(0, 20)}" has ${targets.length} targets`);
      if (typeof button.callback_data === "string" && Buffer.byteLength(button.callback_data, "utf8") > CALLBACK_DATA_LIMIT) {
        problems.push(`callback_data over ${CALLBACK_DATA_LIMIT} bytes: ${Buffer.byteLength(button.callback_data)}`);
      }
      if (typeof button.url === "string" && !/^(https?:\/\/|tg:\/\/)/.test(button.url)) {
        problems.push(`button url is not http(s)/tg: ${button.url.slice(0, 30)}`);
      }
    }
  });
  if (total > BUTTONS_TOTAL_LIMIT) problems.push(`${total} buttons (max ${BUTTONS_TOTAL_LIMIT})`);
  return problems;
}

export function validateTelegramCall(call) {
  const problems = [];
  const body = call?.body ?? {};
  const method = call?.method ?? "";
  if (method === "sendMessage" || method === "editMessageText") {
    const text = body.text;
    if (typeof text !== "string") problems.push("text is not a string");
    else {
      if (!text.trim()) problems.push("empty text");
      if (units(text) > MESSAGE_TEXT_LIMIT) problems.push(`text ${units(text)} units (max ${MESSAGE_TEXT_LIMIT})`);
      if (body.parse_mode === "HTML") problems.push(...validateHtml(text));
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) problems.push("text contains control characters");
    }
  }
  if (method === "sendPhoto" || method === "sendDocument") {
    const caption = body.caption;
    if (typeof caption === "string") {
      if (units(caption) > CAPTION_LIMIT) problems.push(`caption ${units(caption)} units (max ${CAPTION_LIMIT})`);
      if (body.parse_mode === "HTML") problems.push(...validateHtml(caption));
    }
  }
  if (body.reply_markup) problems.push(...validateKeyboard(body.reply_markup));
  if (method === "setMyCommands") {
    const commands = body.commands;
    if (!Array.isArray(commands)) problems.push("commands is not an array");
    else {
      if (commands.length > MAX_COMMANDS) problems.push(`${commands.length} commands (max ${MAX_COMMANDS})`);
      for (const command of commands) {
        if (!/^[a-z0-9_]{1,32}$/.test(String(command?.command ?? ""))) problems.push(`invalid command name: ${String(command?.command).slice(0, 40)}`);
        if (units(command?.description ?? "") > COMMAND_DESC_LIMIT) problems.push(`description too long for /${command?.command}`);
        if (command?.command && units(command.command) > COMMAND_LEN_LIMIT) problems.push(`command too long: ${command.command}`);
      }
    }
  }
  return problems.map((problem) => `${method || "(no method)"}: ${problem}`);
}

export function validateTelegramCalls(calls) {
  const violations = [];
  for (const call of calls ?? []) {
    for (const problem of validateTelegramCall(call)) violations.push(problem);
  }
  return violations;
}
