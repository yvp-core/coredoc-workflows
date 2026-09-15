#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  deliverCaptureEvent,
  resolveWorkflowRuntime,
} from "./capture-client.mjs";
import { captureStateRecorder } from "./capture-state.mjs";
import { normalizedSpecPath, specRefFor } from "./spec-artifact.mjs";
import {
  applyGates,
  evaluateRunStageGates,
  gateMode,
  lastRunAddendum,
  runIsBound,
  skipReason,
} from "./workflow-gates.mjs";
import {
  finishWorkflowStage,
  liveWorkflowRun,
  recordWorkflowGates,
  setWorkflowRunSpecRef,
  startWorkflowStage,
} from "./workflow-run-state.mjs";

const STAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;
const FINISH_OUTCOMES = new Set(["success", "failed", "blocked"]);
const FINISH_ONLY_FLAGS = new Set([
  "--outcome",
  "--spec-path",
  "--skip-intent",
  "--skip-mcp",
]);
const VALUE_FLAGS = new Set(["--stage-id", ...FINISH_ONLY_FLAGS]);

export function parseStageArgs(args) {
  const [action, ...flags] = args;
  if (action !== "start" && action !== "finish") {
    throw new Error("stage action must be start or finish");
  }
  const values = {};
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (!VALUE_FLAGS.has(flag)) {
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
  for (const flag of FINISH_ONLY_FLAGS) {
    if (action === "start" && values[flag.slice(2)] !== undefined) {
      throw new Error(`${flag} is supported only for finish`);
    }
  }
  if (action === "finish" && values.outcome === undefined) {
    throw new Error("--outcome is required for finish");
  }
  if (action === "finish" && !FINISH_OUTCOMES.has(values.outcome)) {
    throw new Error("--outcome must be one of: success, failed, blocked");
  }
  // The specification path belongs to the stage that writes it; every other
  // stage judges the artifact the route already recorded.
  if (values["spec-path"] !== undefined && values["stage-id"] !== "spec") {
    throw new Error("--spec-path is supported only on the spec stage");
  }
  return {
    action,
    stageId: values["stage-id"],
    ...(action === "finish" ? { outcome: values.outcome } : {}),
    ...(values["spec-path"] === undefined
      ? {}
      : { specPath: values["spec-path"] }),
    ...(values["skip-intent"] === undefined
      ? {}
      : { skipIntentReason: skipReason("skip-intent", values["skip-intent"]) }),
    ...(values["skip-mcp"] === undefined
      ? {}
      : { skipMcpReason: skipReason("skip-mcp", values["skip-mcp"]) }),
  };
}

/**
 * Judge a close against what the host observed in this stage attempt. It runs
 * while the occurrence is still open, so the observations read are exactly the
 * attempt's own (LIM-1); on a refusal nothing is written and the stage stays
 * open for the remedy.
 */
function gateStageFinish(
  { sessionId, stageId, outcome, specPath, skipIntentReason, skipMcpReason, at },
  { env },
) {
  const state = liveWorkflowRun(sessionId, { env });
  if (!state) return undefined;
  const specRef =
    specPath === undefined
      ? state.specRef
      : setWorkflowRunSpecRef(
          sessionId,
          specRefFor(
            state.repositoryKey,
            normalizedSpecPath(specPath, state.repoRoot),
          ),
          { env },
        )?.specRef;
  const bound = runIsBound(state);
  const results = evaluateRunStageGates(
    sessionId,
    specRef === undefined ? state : { ...state, specRef },
    stageId,
    {
      env,
      ...(skipIntentReason === undefined ? {} : { skipIntentReason }),
      ...(skipMcpReason === undefined ? {} : { skipMcpReason }),
    },
  );
  const gated = applyGates(results, { outcome, bound, mode: gateMode(env) });
  if (gated.refusal !== undefined) throw new Error(gated.refusal);
  const attempt = state.stageProgress?.[stageId]?.attempt;
  recordWorkflowGates(
    sessionId,
    gated.results.map((entry) => ({
      ...entry,
      at,
      ...(Number.isInteger(attempt) ? { attempt } : {}),
    })),
    { env },
  );
  return gated;
}

export async function runWorkflowStage(
  {
    action,
    stageId,
    outcome,
    specPath,
    skipIntentReason,
    skipMcpReason,
    sessionId,
    at = new Date().toISOString(),
  },
  {
    env = process.env,
    cwd = process.cwd(),
    idFactory,
    deliver = deliverCaptureEvent,
    gateFinish = gateStageFinish,
  } = {},
) {
  const attributedSessionId = sessionId ?? env.COREDOC_WORKFLOWS_SESSION_ID;
  const gated =
    action === "finish"
      ? gateFinish(
          {
            sessionId: attributedSessionId,
            stageId,
            outcome,
            specPath,
            skipIntentReason,
            skipMcpReason,
            at,
          },
          { env },
        )
      : undefined;
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
  if (!transition.event) {
    // `inactive` never means a delivery problem: name the run that was closed.
    return transition.status === "inactive"
      ? { ...transition, ...lastRunAddendum({ env }) }
      : transition;
  }

  const run = liveWorkflowRun(attributedSessionId, { env });
  const capture = await deliver(transition.event, {
    env,
    sessionId: attributedSessionId,
    createRecorder: captureStateRecorder({
      // The run's own project key and checkout, so a stage event lands in the
      // same capture state file the run's history line folds in.
      projectKey: run?.projectKey,
      env,
      cwd: run?.repoRoot || cwd,
    }),
  });
  return {
    status: transition.status,
    occurrence: {
      occurrenceId: transition.occurrence.occurrenceId,
      stageId: transition.occurrence.stageId,
      attempt: transition.occurrence.attempt,
    },
    capture,
    ...(gated === undefined || gated.results.length === 0
      ? {}
      : { gates: gated.results }),
    ...(gated?.warned === undefined ? {} : { gatesWarned: true }),
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
