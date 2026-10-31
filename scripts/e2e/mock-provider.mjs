#!/usr/bin/env node
/**
 * Mock OpenAI-compatible provider for isolated end-to-end acceptance runs.
 *
 * pi requires Server-Sent Events for streaming completions; a non-streaming JSON
 * response makes it abort with "Stream ended without finish_reason". Both paths are
 * implemented so the mock works regardless of whether `stream` is requested.
 *
 * Usage: node mock-provider.mjs [--port 9911] [--log /tmp/x/provider.jsonl] [--reply MOCK_OK]
 */
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const PORT = Number(argValue("--port", "9911"));
const LOG_PATH = argValue("--log", "/tmp/pitg-e2e/provider.jsonl");
const REPLY = argValue("--reply", "MOCK_OK");

mkdirSync(dirname(LOG_PATH), { recursive: true });
writeFileSync(LOG_PATH, "");

function record(entry) {
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch {
    // never break the mock over logging
  }
}

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname.endsWith("/models")) {
    return res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        object: "list",
        data: [{ id: "mock-model", object: "model", owned_by: "mock" }],
      }),
    );
  }

  if (!url.pathname.includes("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "not found" } }));
  }

  const body = await readBody(req);
  let parsed = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    // keep {}
  }
  // Surface the incoming prompt so the driver can prove the Telegram text reached the model.
  const promptText = (parsed.messages ?? [])
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n");
  // pi's system prompt is small enough for `prompt`; OMP's is not, so record the
  // user-role text separately or assertions silently search a truncated string.
  const userText = (parsed.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n");
  // The driver's newest instruction only: earlier codes (ask probes, an earlier
  // approval probe) stay in the history, so anything that must follow the latest
  // text reads this instead of the joined `userText`.
  const latestUserMessage = (parsed.messages ?? []).filter((m) => m.role === "user").at(-1);
  const latestUserText = latestUserMessage === undefined ? ""
    : (typeof latestUserMessage.content === "string" ? latestUserMessage.content : JSON.stringify(latestUserMessage.content ?? ""));
  const approvalBashMatch = /PROBE_APPROVAL_BASH:(\S+)/.exec(latestUserText);

  const toolNames = (parsed.tools ?? [])
    .map((tool) => tool?.function?.name ?? tool?.name ?? "")
    .filter(Boolean);
  const lastMessage = (parsed.messages ?? []).at(-1);
  record({
    ts: Date.now(),
    direction: "in",
    model: parsed.model,
    prompt: promptText.slice(0, 4000),
    userText: userText.slice(0, 4000),
    // OMP's system prompt alone overflows the slice above, so a driver that must
    // see what the host just sent - a tool result, the latest user text - reads
    // the final message instead.
    lastRole: typeof lastMessage?.role === "string" ? lastMessage.role : undefined,
    lastText: lastMessage === undefined ? undefined
      : JSON.stringify(lastMessage.content ?? lastMessage.text ?? "").slice(0, 2000),
    tools: toolNames,
  });

  // Scripted tool call: a driver message containing ASK_TOOL_PROBE makes the
  // model invoke the host's `ask` tool (when advertised), so the interactive
  // prompt path — render in the TUI, answer through the mirror — is exercised
  // exactly as a real model would. The follow-up request carries a tool result
  // and falls through to the normal text reply.
  // Only the request that immediately follows a tool result is the echo of an
  // answer. A tool result somewhere in the history must not rule out a later ask:
  // a driver raises the single-question ask and then the multi-question one.
  const justAnswered = lastMessage?.role === "tool" || lastMessage?.role === "toolResult";
  const askTool = toolNames.find((name) => name === "ask");
  const triggerAsk = Boolean(askTool) && !justAnswered && !approvalBashMatch && latestUserText.includes("ASK_TOOL_PROBE")
    && !latestUserText.includes("ASK_TOOL_PROBE_MULTI") && !latestUserText.includes("ASK_TOOL_PROBE_CHECK");
  const askArguments = JSON.stringify({
    questions: [{
      id: "e2e-color",
      question: "Pick a color for the acceptance run",
      header: "E2E Ask",
      options: [{ label: "red" }, { label: "green" }, { label: "blue" }],
      recommended: 1,
    }],
  });

  // Multi-question / multi-select variant for the parity suite: the first
  // question is a checkbox group, the second a single choice, so the mirror
  // must toggle instead of submitting on the first pick.
  // An approval probe in the latest message outranks every ask trigger.
  const triggerMultiAsk = Boolean(askTool) && !justAnswered && !approvalBashMatch && latestUserText.includes("ASK_TOOL_PROBE_MULTI");
  const triggerCheckAsk = Boolean(askTool) && !justAnswered && !approvalBashMatch && latestUserText.includes("ASK_TOOL_PROBE_CHECK");
  const checkAskArguments = JSON.stringify({
    questions: [{
      id: "e2e-toppings",
      question: "Pick toppings",
      header: "E2E Multi",
      multi: true,
      options: [{ label: "cheese" }, { label: "mushroom" }, { label: "olive" }],
    }],
  });
  const multiAskArguments = JSON.stringify({
    questions: [
      {
        id: "e2e-toppings",
        question: "Pick toppings",
        header: "E2E Multi",
        multi: true,
        options: [{ label: "cheese" }, { label: "mushroom" }, { label: "olive" }],
      },
      {
        id: "e2e-size",
        question: "Pick a size",
        header: "E2E Size",
        options: [{ label: "small" }, { label: "large" }],
      },
    ],
  });

  const askArgs = triggerCheckAsk ? checkAskArguments : (triggerMultiAsk ? multiAskArguments : askArguments);
  const triggerAnyAsk = triggerAsk || triggerMultiAsk || triggerCheckAsk;

  // Stage 0 host probe: scripted calls for arbitrary advertised tools. The
  // prompt names the tool (PROBE_TOOL:<name>) or a pi-goal shape
  // (PROBE_GOAL_CONFIRM / _QUESTION / _QUESTIONNAIRE); approval probing picks
  // the first mutating tool the host advertises, and PROBE_APPROVAL_BASH:<path>
  // pins `bash` to `touch <path>` so a driver can deny the call and then assert
  // the file was never created. Arguments are derived from the
  // tool schema, with semantic overrides for the shapes we drive.
  const probeMatch = /PROBE_TOOL:([A-Za-z0-9_]+)/.exec(latestUserText);
  const goalMatch = /PROBE_GOAL_(QUESTIONNAIRE|CONFIRM|QUESTION)/.exec(latestUserText);
  const approvalProbe = !approvalBashMatch && latestUserText.includes("PROBE_APPROVAL");
  // PROBE_SLOW_BASH: a bash call that runs for about six seconds and prints SLOW_DONE,
  // so a driver can open a command while agent tool output is still arriving.
  const slowBashMatch = latestUserText.includes("PROBE_SLOW_BASH");

  // Sub-agent probe: a driver message containing TASK_TOOL_PROBE makes the model call
  // OMP's `task` tool once, which spawns a sub-agent session. The sub-agent receives
  // SUBAGENT_E2E_PROMPT as its user message and answers with SUBAGENT_E2E_REPLY.
  const triggerTaskProbe = toolNames.includes("task") && !justAnswered && !approvalProbe && !approvalBashMatch
    && latestUserText.includes("TASK_TOOL_PROBE");
  const taskArguments = JSON.stringify({
    name: "e2e-sub",
    task: "SUBAGENT_E2E_PROMPT: reply with the word done",
    solutionSpace: "none",
  });
  const isSubAgentRequest = latestUserText.includes("SUBAGENT_E2E_PROMPT");
  const replyText = isSubAgentRequest ? "SUBAGENT_E2E_REPLY" : REPLY;
  const goalToolName = goalMatch
    ? (goalMatch[1] === "CONFIRM"
      ? "propose_goal_draft"
      : (goalMatch[1] === "QUESTION" ? "goal_question" : "goal_questionnaire"))
    : undefined;
  const approvalToolName = approvalProbe
    ? ["write", "edit", "bash"].find((name) => toolNames.includes(name))
    : undefined;
  const requestedProbeTool = probeMatch?.[1] ?? goalToolName ?? approvalToolName
    ?? (approvalBashMatch && toolNames.includes("bash") ? "bash" : undefined)
    ?? (slowBashMatch && toolNames.includes("bash") ? "bash" : undefined);
  const probeToolDef = requestedProbeTool
    ? (parsed.tools ?? []).find((tool) => (tool?.function?.name ?? tool?.name) === requestedProbeTool)
    : undefined;
  const probeTool = probeToolDef
    ? (probeToolDef.function?.name ?? probeToolDef.name)
    : undefined;
  const triggerProbe = Boolean(probeTool) && !justAnswered
    && Boolean(probeMatch || goalMatch || approvalProbe || approvalBashMatch || slowBashMatch);

  const fill = (schema) => {
    if (!schema || typeof schema !== "object") return "probe";
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
    if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return fill(schema.oneOf[0]);
    if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return fill(schema.anyOf[0]);
    switch (schema.type) {
      case "string": return schema.format === "path" ? "/tmp/pitg-probe-approval.txt" : "probe";
      case "number":
      case "integer": return 0;
      case "boolean": return false;
      case "array": return [fill(schema.items)];
      case "object": {
        const result = {};
        for (const key of schema.required ?? []) result[key] = fill(schema.properties?.[key]);
        return result;
      }
      default: return "probe";
    }
  };
  const probeArguments = (() => {
    if (!probeTool) return "{}";
    if (probeTool === "propose_goal_draft") {
      return JSON.stringify({ objective: "PROBE GOAL OBJECTIVE", autoContinue: true, sisyphus: false });
    }
    if (probeTool === "goal_question") {
      return JSON.stringify({ question: "PROBE QUESTION", context: "stage 0 probe", options: ["alpha", "beta", "gamma"], recommended: 0 });
    }
    if (probeTool === "goal_questionnaire") {
      return JSON.stringify({ questions: [
        { id: "scope", question: "PROBE QUESTION ONE", options: ["alpha", "beta"] },
        { id: "success", question: "PROBE QUESTION TWO", options: ["gamma", "delta"] },
      ] });
    }
    if (probeTool === "write") {
      return JSON.stringify({ path: "/tmp/pitg-probe-approval.txt", content: "probe" });
    }
    if (probeTool === "edit") {
      return JSON.stringify({ path: "/tmp/pitg-probe-approval.txt", old_string: "probe", new_string: "probe" });
    }
    if (probeTool === "bash") {
      if (approvalBashMatch) return JSON.stringify({ command: `touch ${approvalBashMatch[1]}` });
      return JSON.stringify({ command: slowBashMatch ? "sleep 6; echo SLOW_DONE" : "true" });
    }
    const parameters = probeToolDef?.function?.parameters ?? probeToolDef?.parameters ?? {};
    const required = parameters.required ?? Object.keys(parameters.properties ?? {});
    const args = {};
    for (const key of required) args[key] = fill(parameters.properties?.[key]);
    return JSON.stringify(args);
  })();
  // The task probe is keyed on the latest user message, so it outranks the ask triggers,
  // which match the whole history (an earlier ASK_TOOL_PROBE_MULTI would otherwise win).
  const scriptedCall = triggerTaskProbe
    ? { name: "task", arguments: taskArguments }
    : (triggerProbe
      ? { name: probeTool, arguments: probeArguments }
      : (triggerAnyAsk ? { name: askTool, arguments: askArgs } : undefined));

  // Slow reply probe: a driver message containing SLOW_REPLY_PROBE gets an ordinary text reply
  // that starts only after 6 s, so a turn is still running while the driver sends more input.
  // Tool-result turns are excluded so the probe reply is never delayed mid-tool-loop.
  if (!scriptedCall && !justAnswered && latestUserText.includes("SLOW_REPLY_PROBE")) {
    await new Promise((resolve) => setTimeout(resolve, 6000));
  }

  const wantsStream = parsed.stream === true;
  const id = "chatcmpl-e2e";
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model: parsed.model ?? "mock-model" };

  if (wantsStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
    if (scriptedCall) {
      res.write(chunk({
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_e2e_probe",
              type: "function",
              function: { name: scriptedCall.name, arguments: scriptedCall.arguments },
            }],
          },
          finish_reason: null,
        }],
      }));
      res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    for (const word of replyText.split(" ")) {
      res.write(chunk({ ...base, choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }] }));
    }
    res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model: parsed.model ?? "mock-model",
      choices: [scriptedCall
        ? {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_e2e_probe",
                type: "function",
                function: { name: scriptedCall.name, arguments: scriptedCall.arguments },
              }],
            },
            finish_reason: "tool_calls",
          }
        : { index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }),
  );
});

// Keep-alive must outlive the driver's idle gaps: a pooled socket closed server-side
// during a long `npm install` surfaces as `fetch failed` / `ECONNRESET` downstream.
server.keepAliveTimeout = 600_000;
server.headersTimeout = 610_000;

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MOCK_PROVIDER_READY port=${PORT} log=${LOG_PATH}`);
});

server.on("error", (error) => {
  console.error(`MOCK_PROVIDER_ERROR ${error.code ?? ""} ${error.message}`);
});
