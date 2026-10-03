#!/usr/bin/env node
// Fake codex CLI for Interview OS runtime tests. Modes via FAKE_CODEX_MODE:
//   ok | eager | crash | malformed-event | malformed-output | hang | app-crash-once
//   app-crash-midturn | app-crash-midturn-once (crashes mid-turn once; the
//   restarted process works — remembers via a marker in FAKE_CODEX_RECORD)
// When FAKE_CODEX_RECORD is set, interesting app-server params are appended to
// that file as JSON lines so tests can assert on what was sent.
import fs from "node:fs";
import readline from "node:readline";

const MODE = process.env.FAKE_CODEX_MODE || "ok";
const RECORD = process.env.FAKE_CODEX_RECORD || null;
const args = process.argv.slice(2);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function record(obj) {
  if (RECORD) fs.appendFileSync(RECORD, JSON.stringify(obj) + "\n");
}

function runExec() {
  if (MODE === "crash") {
    process.stderr.write("fake-codex: simulated crash\n");
    process.exit(3);
  }
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (stdin += c));
  process.stdin.on("end", () => {
    record({ event: "exec", argv: args });
    switch (MODE) {
      case "hang":
        setInterval(() => {}, 60_000);
        return;
      case "malformed-event":
        process.stdout.write("garbage line one\nnot json either {{{\n");
        emit({ type: "thread.started", thread_id: "thr_fake_exec" });
        emit({ type: "turn.completed", usage: {} });
        return;
      case "malformed-output":
        emit({ type: "thread.started", thread_id: "thr_fake_exec" });
        emit({ type: "turn.started" });
        emit({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "this is not json" },
        });
        emit({ type: "turn.completed", usage: {} });
        return;
      default: {
        const output = {
          answer: 42,
          argv: args,
          env: { SECRET_TOKEN: process.env.SECRET_TOKEN !== undefined },
          promptLen: stdin.length,
          promptMarkerSeen: stdin.includes("PROMPT_MARKER"),
        };
        const text = JSON.stringify(output);
        process.stdout.write("this stdout line is not JSON\n");
        emit({ type: "thread.started", thread_id: "thr_fake_exec" });
        emit({ type: "turn.started" });
        emit({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text },
        });
        emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
        return;
      }
    }
  });
}

const APPROVAL_ID = "srv-approval-1";
let approvalDeclined = false;
let approvalResolve = null;
let threadSeq = 0;
let turnSeq = 0;
let lastTurn = { model: null, effort: null, outputSchema: false };
let lastThread = { model: null, ephemeral: null };

function alreadyCrashedMidturn() {
  if (!RECORD || !fs.existsSync(RECORD)) return false;
  return fs.readFileSync(RECORD, "utf8").includes('"crashed-midturn"');
}

function runTurn(threadId, turnId, turnNumber) {
  const finish = () => {
    if (MODE === "app-crash-midturn") process.exit(3);
    if (MODE === "app-crash-midturn-once" && !alreadyCrashedMidturn()) {
      record({ event: "crashed-midturn" });
      process.exit(3);
    }
    if (MODE === "hang") return; // never completes; client must interrupt
    const output = {
      answer: 42,
      turn: turnNumber,
      approvalDeclined,
      model: lastTurn.model,
      effort: lastTurn.effort,
      threadModel: lastThread.model,
      ephemeral: lastThread.ephemeral,
    };
    const text = MODE === "malformed-output" ? "this is not json" : JSON.stringify(output);
    emit({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, delta: text.slice(0, 10) },
    });
    emit({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, delta: text.slice(10) },
    });
    emit({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "item_0", type: "agentMessage", text, phase: "final_answer" },
      },
    });
    emit({
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: turnId, status: "completed", error: null, items: [] },
      },
    });
    if (MODE === "app-crash-once" && turnNumber === 1) {
      process.exit(3);
    }
  };

  if (turnNumber === 1 && MODE !== "app-crash-midturn") {
    // server→client approval request; the client must decline (never approve)
    emit({ id: APPROVAL_ID, method: "execCommandApproval", params: { command: ["rm", "-rf", "/"] } });
    const approvalSeen = new Promise((r) => (approvalResolve = r));
    // the client must always respond to server→client requests; the 10s cap
    // only bounds a pathological client, it is not on the hot path
    Promise.race([approvalSeen, new Promise((r) => setTimeout(r, 10_000))]).then(finish);
  } else {
    finish();
  }
}

const FAKE_MODELS = [
  {
    id: "fake-small",
    model: "fake-small",
    displayName: "Fake Small",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "fast" },
      { reasoningEffort: "medium", description: "balanced" },
    ],
    defaultReasoningEffort: "medium",
  },
  {
    id: "fake-large",
    model: "fake-large",
    displayName: "Fake Large",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "fast" },
      { reasoningEffort: "medium", description: "balanced" },
      { reasoningEffort: "high", description: "deep" },
    ],
    defaultReasoningEffort: "high",
  },
];

function runAppServer() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      // response to our server→client request
      if (msg.id === APPROVAL_ID) {
        approvalDeclined = msg.error !== undefined;
        if (approvalResolve) approvalResolve();
      }
      return;
    }
    const reply = (result) => {
      if (msg.id !== undefined) emit({ id: msg.id, result });
    };
    switch (msg.method) {
      case "initialize":
        reply({ userAgent: "fake-codex/0.0.0" });
        break;
      case "initialized":
        break; // notification
      case "model/list": {
        record({ event: "model/list", params: msg.params });
        // honour pagination: two fake models across two pages
        if (msg.params?.cursor === "page2") {
          reply({ data: [FAKE_MODELS[1]], nextCursor: null });
        } else {
          reply({ data: [FAKE_MODELS[0]], nextCursor: "page2" });
        }
        break;
      }
      case "thread/start": {
        lastThread = {
          model: msg.params?.model ?? null,
          ephemeral: msg.params?.ephemeral ?? null,
        };
        record({ event: "thread/start", ...lastThread });
        reply({ thread: { id: `thread-${++threadSeq}` } });
        break;
      }
      case "thread/resume":
        reply({ thread: { id: msg.params?.threadId ?? "thread-resumed" } });
        break;
      case "turn/start": {
        lastTurn = {
          model: msg.params?.model ?? null,
          effort: msg.params?.effort ?? null,
          outputSchema: msg.params?.outputSchema != null,
        };
        record({ event: "turn/start", ...lastTurn, threadId: msg.params?.threadId });
        const turnId = `turn-${++turnSeq}`;
        reply({ turn: { id: turnId, status: "inProgress" } });
        if (MODE === "eager") {
          // Deliver notifications with the turn/start response to exercise
          // clients that must subscribe before awaiting the RPC result.
          runTurn(msg.params?.threadId, turnId, turnSeq);
        } else {
          setImmediate(() => runTurn(msg.params?.threadId, turnId, turnSeq));
        }
        break;
      }
      case "turn/interrupt":
        record({ event: "turn/interrupt", params: msg.params });
        reply({});
        break;
      default:
        if (msg.id !== undefined) {
          emit({ id: msg.id, error: { code: -32601, message: "unknown method" } });
        }
    }
  });
}

if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.157.0\n");
} else if (args[0] === "exec") {
  runExec();
} else if (args[0] === "app-server") {
  runAppServer();
} else {
  process.stderr.write(`fake-codex: unknown invocation ${args[0]}\n`);
  process.exit(2);
}
