#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { workflowRunContext, workflowRunStatus } from "./run-status.mjs";
import { liveWorkflowRun } from "./workflow-run-state.mjs";

// Only a resumed or compacted session can hold a run the model no longer
// remembers; `startup` and `clear` sessions carry a fresh ID and no run.
const REORIENTING_SOURCES = new Set(["resume", "compact"]);

export function sessionStartOutput(event, { env = process.env } = {}) {
  if (
    event?.hook_event_name !== "SessionStart" ||
    Object.hasOwn(event, "agent_id") ||
    !REORIENTING_SOURCES.has(event.source)
  ) {
    return "";
  }
  const sessionId = event.session_id;
  // The session is back: a run suspended by its resumable exit becomes active
  // here rather than at its first lifecycle command. A held lock only defers
  // that to the first command; the read-only summary below still goes out.
  try {
    liveWorkflowRun(sessionId, { env });
  } catch {
    // Deliberate: re-anchoring must not depend on winning the stage lock.
  }
  const context = workflowRunContext(workflowRunStatus(sessionId, { env }));
  if (context === "") return "";
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  })}\n`;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const output = sessionStartOutput(JSON.parse(input || "{}"));
  if (output !== "") process.stdout.write(output);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    /* Session start stays fail-open; a missing run summary costs nothing. */
  });
}
