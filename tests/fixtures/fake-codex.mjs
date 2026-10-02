#!/usr/bin/env node
// Fake codex CLI for Interview OS runtime tests. Modes via FAKE_CODEX_MODE:
//   ok | crash | malformed-event | malformed-output | hang | app-crash-once
import readline from "node:readline";

const MODE = process.env.FAKE_CODEX_MODE || "ok";
const args = process.argv.slice(2);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
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

function runTurn(threadId, turnId, turnNumber) {
  const finish = () => {
    const output = { answer: 42, turn: turnNumber, approvalDeclined };
    const text = JSON.stringify(output);
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

  if (turnNumber === 1) {
    // server→client approval request; the client must decline (never approve)
    emit({ id: APPROVAL_ID, method: "execCommandApproval", params: { command: ["rm", "-rf", "/"] } });
    const approvalSeen = new Promise((r) => (approvalResolve = r));
    Promise.race([approvalSeen, new Promise((r) => setTimeout(r, 800))]).then(finish);
  } else {
    finish();
  }
}

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
      case "thread/start":
        reply({ thread: { id: `thread-${++threadSeq}` } });
        break;
      case "thread/resume":
        reply({ thread: { id: msg.params?.threadId ?? "thread-resumed" } });
        break;
      case "turn/start": {
        const turnId = `turn-${++turnSeq}`;
        reply({ turn: { id: turnId, status: "inProgress" } });
        setImmediate(() => runTurn(msg.params?.threadId, turnId, turnSeq));
        break;
      }
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
