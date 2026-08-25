#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  deliverCaptureEvent,
  resolveWorkflowRuntime,
} from "./capture-client.mjs";
import {
  finishWorkflowStage,
  startWorkflowStage,
} from "./workflow-run-state.mjs";

const STAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;
const FINISH_OUTCOMES = new Set(["success", "failed", "blocked"]);

export function parseStageArgs(args) {
  const [action, ...flags] = args;
  if (action !== "start" && action !== "finish") {
    throw new Error("stage action must be start or finish");
  }
  const values = {};
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag !== "--stage-id" && flag !== "--outcome") {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = flags[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values[flag.slice(2)] = value;
    index += 1;
  }
  if (!STAGE_ID_RE.test(String(values["stage-id"] ?? ""))) {
    throw new Error("--stage-id requires a compact stage identifier");
  }
  if (action === "start" && values.outcome !== undefined) {
    throw new Error("--outcome is supported only for finish");
  }
  if (action === "finish" && values.outcome === undefined) {
    throw new Error("--outcome is required for finish");
  }
  if (action === "finish" && !FINISH_OUTCOMES.has(values.outcome)) {
    throw new Error("--outcome must be one of: success, failed, blocked");
  }
  return {
    action,
    stageId: values["stage-id"],
    ...(action === "finish" ? { outcome: values.outcome } : {}),
  };
}

export async function runWorkflowStage(
  {
    action,
    stageId,
    outcome,
    sessionId,
    at = new Date().toISOString(),
  },
  {
    env = process.env,
    idFactory,
    deliver = deliverCaptureEvent,
  } = {},
) {
  const attributedSessionId = sessionId ?? env.COREDOC_WORKFLOWS_SESSION_ID;
  const transition =
    action === "start"
      ? startWorkflowStage(
          attributedSessionId,
          stageId,
          { at },
          { env, ...(idFactory === undefined ? {} : { idFactory }) },
        )
      : finishWorkflowStage(
          attributedSessionId,
          stageId,
          outcome,
          { at },
          { env },
        );
  if (!transition.event) return transition;

  const capture = await deliver(transition.event, {
    env,
    sessionId: attributedSessionId,
  });
  return {
    status: transition.status,
    occurrence: {
      occurrenceId: transition.occurrence.occurrenceId,
      stageId: transition.occurrence.stageId,
      attempt: transition.occurrence.attempt,
    },
    capture,
  };
}

async function main() {
  const options = parseStageArgs(process.argv.slice(2));
  const runtime = resolveWorkflowRuntime();
  const result = await runWorkflowStage(
    { ...options, sessionId: runtime.sessionId },
    { env: runtime.env },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "unattributed" || result.status === "inactive") {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
