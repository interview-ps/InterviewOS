#!/usr/bin/env node
// Fake opencode / devin CLI for the Python runtime tests (no provider install).
//
//   opencode: `run --format json` reads the prompt on stdin and answers with an
//             NDJSON text part; `models` lists provider-qualified ids.
//   devin:    `-p --prompt-file <file>` answers with the payload on stdout;
//             `models list --format json` lists model families.
//
// Modes via OPENCODE_FAKE_MODE / DEVIN_FAKE_MODE (both prefixes are on the
// provider env allowlists, so the mode survives the child-env filter):
//   ok | crash | malformed | empty | hang | error-event (opencode only)
// The payload echoes argv and whether the prompt (and the secret) reached the
// child, so tests can assert what was sent.
import fs from "node:fs";

const MODE =
  process.env.OPENCODE_FAKE_MODE || process.env.DEVIN_FAKE_MODE || "ok";
const args = process.argv.slice(2);

const isOpencodeRun = args[0] === "run";
const isOpencodeModels = args[0] === "models" && args.length === 1;
const isDevinPrompt = args.includes("-p");
const isDevinModels = args[0] === "models" && args[1] === "list";

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
  });
}

function promptFileText() {
  const index = args.indexOf("--prompt-file");
  if (index === -1) return "";
  try {
    return fs.readFileSync(args[index + 1], "utf8");
  } catch {
    return "";
  }
}

function payload(prompt) {
  return {
    answer: 42,
    argv: args,
    promptMarkerSeen: prompt.includes("PROMPT_MARKER"),
    promptLen: prompt.length,
    env: { SECRET_TOKEN: process.env.SECRET_TOKEN !== undefined },
  };
}

function opencodeText(text) {
  process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text } }) + "\n");
}

function fail(message) {
  process.stderr.write(`fake-provider: ${message}\n`);
  process.exit(3);
}

if (args.includes("--version")) {
  process.stdout.write("fake-provider 1.2.3\n");
} else if (isOpencodeModels) {
  process.stdout.write("anthropic/claude-sonnet-5\nopencode-go/gpt-5.6-luna\nnot-a-model\n");
} else if (isOpencodeRun) {
  readStdin().then((stdin) => {
    switch (MODE) {
      case "crash":
        fail("simulated crash");
        return;
      case "hang":
        setInterval(() => {}, 60_000);
        return;
      case "malformed":
        opencodeText("this is not json");
        return;
      case "empty":
        return;
      case "error-event":
        process.stdout.write(
          JSON.stringify({
            type: "error",
            error: { name: "UnknownError", data: { message: "simulated provider error" } },
          }) + "\n",
        );
        process.exit(1);
        return;
      default:
        opencodeText(JSON.stringify(payload(stdin)));
    }
  });
} else if (isDevinModels) {
  process.stdout.write(
    JSON.stringify({ families: [{ models: [{ id: "opus" }, { id: "swe" }] }] }) + "\n",
  );
} else if (isDevinPrompt) {
  const prompt = promptFileText();
  switch (MODE) {
    case "crash":
      fail("simulated crash");
      break;
    case "hang":
      setInterval(() => {}, 60_000);
      break;
    case "malformed":
      process.stdout.write("this is not json\n");
      break;
    case "empty":
      break;
    default:
      process.stdout.write(JSON.stringify(payload(prompt)) + "\n");
  }
} else {
  process.stderr.write(`fake-provider: unknown invocation ${args[0]}\n`);
  process.exit(2);
}
