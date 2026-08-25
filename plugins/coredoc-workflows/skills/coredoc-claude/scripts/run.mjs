#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { runBridge, safeProviderDiagnostic } from "../../../scripts/cross-model-runtime.mjs";

const PROVIDER = "claude";
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "TaskCreate",
  "Workflow",
  "RemoteWakeup",
  "SendMessage",
  "ToolSearch",
  "Skill",
].join(",");

function fail(message) {
  throw new Error(message);
}

export function claudeInvocation({ action, grounding, model, effort, sessionId }) {
  if (!model) fail("Claude model is required");
  if (!CLAUDE_EFFORTS.has(effort)) fail(`Claude does not support effort ${effort}`);
  if (grounding !== "artifact") fail("Claude adapter supports artifact grounding only");
  const args = [
    "--print",
    "--output-format",
    "json",
    "--safe-mode",
    "--disable-slash-commands",
    "--model",
    model,
    "--effort",
    effort,
    "--permission-mode",
    "dontAsk",
  ];
  if (action === "continue") {
    if (!sessionId) fail("Claude continuation requires a session id");
    args.push("--resume", sessionId);
  }
  if (action === "review") args.push("--no-session-persistence");
  args.push("--tools", "", "--allowedTools", "", "--disallowedTools", DISALLOWED_TOOLS);
  return { args };
}

export function parseClaudeOutput(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    fail("Claude returned invalid JSON");
  }
  if (envelope?.is_error || envelope?.subtype === "error" || envelope?.api_error_status) {
    const detail = safeProviderDiagnostic([
      envelope.subtype,
      envelope.api_error_status,
      envelope.terminal_reason,
      ...(Array.isArray(envelope.errors) ? envelope.errors : []),
    ].filter(Boolean));
    fail(`Claude reported an error${detail ? `: ${detail}` : ""}`);
  }
  if (typeof envelope?.result !== "string" || envelope.result.trim() === "") {
    fail("Claude returned no final answer");
  }
  return {
    answer: envelope.result,
    ...(typeof envelope.total_cost_usd === "number" ? { costUsd: envelope.total_cost_usd } : {}),
    ...(typeof envelope.session_id === "string" ? { sessionId: envelope.session_id } : {}),
  };
}

export async function main(args = process.argv.slice(2)) {
  return runBridge({
    provider: PROVIDER,
    rawArgs: args,
    invocation: claudeInvocation,
    parseOutput: parseClaudeOutput,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await main(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`coredoc-claude: ${error.message}\n`);
    process.exitCode = 1;
  }
}
