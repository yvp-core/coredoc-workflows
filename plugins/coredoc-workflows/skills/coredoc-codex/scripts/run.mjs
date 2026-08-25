#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { runBridge, safeProviderDiagnostic } from "../../../scripts/cross-model-runtime.mjs";

const PROVIDER = "codex";
const CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "skill_mcp_dependency_install",
  "skill_search",
  "shell_tool",
  "unified_exec",
];

function fail(message) {
  throw new Error(message);
}

export function codexInvocation({ action, grounding, model, effort, sessionId, cwd }) {
  if (!model) fail("Codex model is required");
  if (!CODEX_EFFORTS.has(effort)) fail(`Codex does not support effort ${effort}`);
  if (grounding !== "artifact") fail("Codex adapter supports artifact grounding only");
  const args = [
    "--ask-for-approval",
    "never",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "--cd",
    cwd,
    "exec",
  ];
  if (action === "continue") {
    if (!sessionId) fail("Codex continuation requires a session id");
    args.push("resume", sessionId);
  }
  if (action === "review") args.push("--ephemeral");
  args.push(
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--json",
    "--config",
    `model_reasoning_effort=${JSON.stringify(effort)}`,
  );
  for (const feature of DISABLED_FEATURES) args.push("--disable", feature);
  args.push("--skip-git-repo-check");
  args.push("-");
  return { args };
}

export function parseCodexOutput(stdout) {
  let sessionId;
  let answer;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail("Codex returned invalid JSONL");
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      const text = event.item.text ?? event.item.content;
      if (typeof text === "string" && text.trim() !== "") answer = text;
    }
    if (event.type === "error" || event.type === "turn.failed") {
      const detail = safeProviderDiagnostic(
        event.message ?? event.error?.message ?? event.error ?? event.type,
      );
      fail(`Codex reported an error${detail ? `: ${detail}` : ""}`);
    }
  }
  if (!answer) fail("Codex returned no final answer");
  return { answer, ...(sessionId ? { sessionId } : {}) };
}

export async function main(args = process.argv.slice(2)) {
  return runBridge({
    provider: PROVIDER,
    rawArgs: args,
    invocation: codexInvocation,
    parseOutput: parseCodexOutput,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await main(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`coredoc-codex: ${error.message}\n`);
    process.exitCode = 1;
  }
}
