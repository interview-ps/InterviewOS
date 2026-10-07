#!/usr/bin/env node
// Fake ACP agent for Interview OS runtime tests. Speaks ACP (JSON-RPC 2.0 over
// newline-delimited stdio) so `AcpRuntime` can be exercised without a real
// provider install.
//
// Modes via FAKE_ACP_MODE:
//   ok | malformed | crash | hang | refuse
//   (FAKE_ACP_LOAD_SESSION=0 makes `initialize` report loadSession:false, to
//    exercise the resume fallback)
// FAKE_ACP_RECORD, when set, appends JSON lines describing what the client sent
// (initialize capabilities, session/new, set_config_option, permission outcome,
// prompt length) so tests can assert the security posture and wiring.
//
// The prompt marker / SECRET_TOKEN echo in the payload proves the prompt
// travelled in `session/prompt` (never argv) and the child env was allowlisted.
import fs from "node:fs";
import readline from "node:readline";

const MODE = process.env.FAKE_ACP_MODE || "ok";
const RECORD = process.env.FAKE_ACP_RECORD || null;
const LOAD_SESSION = (process.env.FAKE_ACP_LOAD_SESSION || "1") !== "0";

let nextSession = 0;
let nextOurId = 9000;
const pendingOurs = new Map(); // our server->client request id -> resolve
const pendingPrompts = new Map(); // sessionId -> [prompt request id, ...]
const turnsBySession = new Map();
const modelBySession = new Map();
const effortBySession = new Map();
const costBySession = new Map(); // cumulative session cost (USD), like a real agent

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function record(obj) {
  if (RECORD) fs.appendFileSync(RECORD, JSON.stringify(obj) + "\n");
}
function reply(id, result) {
  emit({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  emit({ jsonrpc: "2.0", id, error: { code, message } });
}
function notify(method, params) {
  emit({ jsonrpc: "2.0", method, params });
}
function serverRequest(method, params) {
  const id = nextOurId++;
  return new Promise((resolve) => {
    pendingOurs.set(id, resolve);
    emit({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pendingOurs.has(id)) {
        pendingOurs.delete(id);
        resolve({ timeout: true });
      }
    }, 5000);
  });
}

const MODEL_OPTIONS = [
  { value: "fake-small", name: "Fake Small" },
  { value: "fake-large", name: "Fake Large" },
];
const EFFORT_OPTIONS = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];

function configOptions(model, effort) {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model || "fake-small",
      options: MODEL_OPTIONS,
    },
    {
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: effort || "medium",
      options: EFFORT_OPTIONS,
    },
  ];
}

function newSessionResult() {
  const sessionId = `ses_fake_${++nextSession}`;
  turnsBySession.set(sessionId, 0);
  return { sessionId, configOptions: configOptions() };
}

async function handlePrompt(msg) {
  const id = msg.id;
  const sessionId = msg.params.sessionId;
  const promptText = (msg.params.prompt || []).map((b) => b.text || "").join("");
  const turn = (turnsBySession.get(sessionId) || 0) + 1;
  turnsBySession.set(sessionId, turn);
  record({
    event: "prompt",
    turn,
    len: promptText.length,
    markerSeen: promptText.includes("PROMPT_MARKER"),
    argv: process.argv.slice(2),
    model: modelBySession.get(sessionId) || null,
    effort: effortBySession.get(sessionId) || null,
  });

  if (MODE === "crash") {
    process.exit(3);
    return;
  }
  if (MODE === "hang") {
    const list = pendingPrompts.get(sessionId) || [];
    list.push(id);
    pendingPrompts.set(sessionId, list);
    return;
  }

  let permission = { outcome: "none", optionId: null };
  if (turn === 1) {
    const outcome = await serverRequest("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "call_1" },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    permission = {
      outcome: outcome && outcome.outcome ? outcome.outcome.outcome : "none",
      optionId: outcome && outcome.outcome ? outcome.outcome.optionId || null : null,
    };
    record({ event: "permission", ...permission });
  }

  if (MODE === "fs") {
    const fsOutcome = await serverRequest("fs/read_text_file", {
      sessionId,
      path: "/etc/passwd",
    });
    record({ event: "fs_request", outcome: fsOutcome });
  }

  if (MODE !== "no-usage") {
    // Session-level context + CUMULATIVE cost (the runtime de-cumulates it).
    const cumulative = (costBySession.get(sessionId) || 0) + 0.005 * turn;
    costBySession.set(sessionId, cumulative);
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used: 1000 * turn,
        size: 200000,
        cost: { amount: cumulative, currency: "USD" },
      },
    });
    record({ event: "usage", sessionId, turn, used: 1000 * turn, cumulative });
  }

  const text =
    MODE === "malformed"
      ? "this is not json"
      : JSON.stringify({
          answer: 42,
          turn,
          promptMarkerSeen: promptText.includes("PROMPT_MARKER"),
          promptLen: promptText.length,
          env: { SECRET_TOKEN: process.env.SECRET_TOKEN !== undefined },
          model: modelBySession.get(sessionId) || null,
          effort: effortBySession.get(sessionId) || null,
          permissionOutcome: permission.outcome,
          permissionOption: permission.optionId,
        });
  const mid = Math.ceil(text.length / 2);
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: text.slice(0, mid) },
    },
  });
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: text.slice(mid) },
    },
  });
  const result = { stopReason: MODE === "refuse" ? "refusal" : "end_turn" };
  if (MODE !== "no-usage" && MODE !== "no-tokens") {
    // Per-turn token counts on the prompt result (End-Turn Token Usage RFD).
    result.usage = { totalTokens: 100 * turn, inputTokens: 70 * turn, outputTokens: 30 * turn };
    record({ event: "turn_usage", sessionId, turn, usage: result.usage });
  }
  reply(id, result);
}

function handleCancel(params) {
  const sessionId = params.sessionId;
  record({ event: "cancel", sessionId });
  const turn = turnsBySession.get(sessionId) || 0;
  const list = pendingPrompts.get(sessionId) || [];
  for (const id of list) {
    const result = { stopReason: "cancelled" };
    if (turn > 0 && MODE !== "no-usage" && MODE !== "no-tokens") {
      result.usage = { totalTokens: 100 * turn, inputTokens: 70 * turn, outputTokens: 30 * turn };
    }
    reply(id, result);
  }
  pendingPrompts.delete(sessionId);
}

function handleRequest(msg) {
  switch (msg.method) {
    case "initialize":
      record({ event: "initialize", capabilities: msg.params.clientCapabilities });
      reply(msg.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: LOAD_SESSION, promptCapabilities: { image: false } },
        agentInfo: { name: "fake-acp", title: "Fake ACP", version: "9.9.9" },
        authMethods: [],
      });
      break;
    case "session/new":
      record({ event: "session/new", cwd: msg.params.cwd, mcpServers: msg.params.mcpServers });
      reply(msg.id, newSessionResult());
      break;
    case "session/load":
      record({ event: "session/load", sessionId: msg.params.sessionId });
      turnsBySession.set(msg.params.sessionId, 0);
      reply(msg.id, { configOptions: configOptions() });
      break;
    case "session/set_config_option": {
      record({
        event: "set_config_option",
        sessionId: msg.params.sessionId,
        configId: msg.params.configId,
        value: msg.params.value,
      });
      if (msg.params.configId === "model") modelBySession.set(msg.params.sessionId, msg.params.value);
      if (msg.params.configId === "thought_level")
        effortBySession.set(msg.params.sessionId, msg.params.value);
      const sessionId = msg.params.sessionId;
      reply(msg.id, {
        configOptions: configOptions(
          modelBySession.get(sessionId),
          effortBySession.get(sessionId),
        ),
      });
      break;
    }
    case "session/prompt":
      handlePrompt(msg);
      break;
    case "session/close":
      record({ event: "session/close", sessionId: msg.params.sessionId });
      reply(msg.id, {});
      break;
    case "authenticate":
      reply(msg.id, {});
      break;
    default:
      replyError(msg.id, -32601, `unknown method ${msg.method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined && msg.id !== undefined) {
    const resolve = pendingOurs.get(msg.id);
    if (resolve) {
      pendingOurs.delete(msg.id);
      resolve(msg.error ? { error: msg.error } : msg.result);
    }
    return;
  }
  if (msg.id !== undefined) {
    handleRequest(msg);
  } else if (msg.method === "session/cancel") {
    handleCancel(msg.params || {});
  }
});
