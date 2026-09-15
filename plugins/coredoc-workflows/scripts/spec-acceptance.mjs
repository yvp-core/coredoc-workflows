#!/usr/bin/env node

/**
 * BR-5 — standalone specification acceptance is a step of the same run.
 *
 * A standalone `spec` run delivers a draft and is parked, not finished
 * (`finish-run --outcome delivered-draft`). When the user approves the draft —
 * usually in a later session — `spec accept --path <spec>` brings that run back
 * so the candidate batch the agent proposes is observed, and `spec accept
 * --finish` applies the candidate check as the precondition of the draft →
 * accepted transition itself. Only then is `status: accepted` written and the
 * single `workflow.run.finished` sent, under the session and capture identity
 * the run started with.
 *
 * Every terminal path here goes through one `terminateRun`, so no run can be
 * finished twice.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveWorkflowRuntime } from "./capture-client.mjs";
import { finishWorkflowRun } from "./finish-run.mjs";
import { resolveProjectKey } from "./project-key.mjs";
import {
  normalizedSpecPath,
  readSpecArtifact,
  specAbsolutePath,
  removeSpecArtifactKey,
  specPathFromRef,
  writeSpecArtifactKey,
} from "./spec-artifact.mjs";
import {
  applyGates,
  evaluateCandidatesGate,
  gateMode,
  runIsBound,
  skipReason,
} from "./workflow-gates.mjs";
import {
  completeWorkflowRun,
  listParkedWorkflowRuns,
  listSuspendedWorkflowRuns,
  liveWorkflowRun,
  parkWorkflowRun,
  parkedRunEnv,
  reactivateParkedRun,
  readWorkflowObservations,
  readWorkflowRun,
  recordWorkflowGates,
  terminateRun,
} from "./workflow-run-state.mjs";

const ACCEPT_STAGE = "accept";
const ACCEPT_FINISH_COMMAND = "coredoc-workflows spec accept --finish";
const VALUE_FLAGS = new Set(["--path", "--reason", "--skip-intent"]);

export function parseSpecArgs(args) {
  const [action, ...flags] = args;
  if (action !== "accept" && action !== "abandon") {
    throw new Error("spec action must be accept or abandon");
  }
  const options = { action };
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--finish") {
      options.finish = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = flags[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--path") options.path = value;
    else if (flag === "--reason") options.reason = skipReason("reason", value);
    else options.skipIntentReason = skipReason("skip-intent", value);
  }
  if (action === "accept") {
    if ((options.path === undefined) === (options.finish === undefined)) {
      throw new Error(
        "spec accept requires either --path <spec> (to reactivate the run) or --finish (to accept it)",
      );
    }
    if (options.finish === undefined && options.skipIntentReason !== undefined) {
      throw new Error("--skip-intent is supported only with --finish");
    }
  } else if (options.reason === undefined) {
    throw new Error('spec abandon requires --reason "<text>"');
  }
  return options;
}

/** The parked or suspended run awaiting acceptance, by run id or spec path. */
export function findAcceptanceRun(
  { sessionId, runId, specPath, projectKey },
  { env = process.env } = {},
) {
  for (const run of listParkedWorkflowRuns({ env, projectKey })) {
    if (
      (runId !== undefined && run.runId === runId) ||
      (runId === undefined &&
        specPath !== undefined &&
        run.specRef !== undefined &&
        specPathFromRef(run.specRef) === specPath)
    ) {
      return { ...run, location: "parked" };
    }
  }
  if (runId === undefined) return undefined;
  // A run re-suspended by a resumable session exit stays in a session slot
  // with its observations; it is taken from there just the same.
  for (const run of listSuspendedWorkflowRuns({ env })) {
    if (run.runId !== runId) continue;
    const state = readWorkflowRun(run.sessionId, { env });
    if (!state?.acceptance) continue;
    return {
      ...run,
      originSessionId: state.acceptance.originSessionId ?? state.sessionId,
      capture: state.acceptance.capture ?? state.capture,
      specRef: state.specRef,
      location: run.sessionId === sessionId ? "session" : "other-session",
    };
  }
  return undefined;
}

export function acceptSpecification(
  { sessionId, path, at = new Date().toISOString() },
  { env = process.env, cwd = process.cwd() } = {},
) {
  const projectKey = resolveProjectKey(cwd, env);
  const specPath = normalizedSpecPath(path, cwd);
  const artifact = readSpecArtifact(resolve(cwd, specPath));
  if (artifact === undefined) {
    throw new Error(`no specification at ${specPath}`);
  }
  const found = findAcceptanceRun(
    {
      sessionId,
      projectKey,
      specPath,
      ...(artifact.run === undefined ? {} : { runId: artifact.run }),
    },
    { env },
  );
  if (found === undefined) {
    return {
      status: "no-pending-run",
      message: `no run awaiting acceptance for ${specPath}`,
    };
  }
  const current = readWorkflowRun(sessionId, { env });
  if (
    current?.status === "active" &&
    current.runId !== found.runId
  ) {
    throw new Error(
      `workflow run ${current.runId} is active in this session; finish or abandon ${current.runId} first`,
    );
  }
  if (found.location === "session") {
    // Already in this session's slot, where the observer is looking: resuming
    // it in place is all the acceptance needs.
    const resumed = liveWorkflowRun(sessionId, { env });
    return {
      status: resumed ? "reactivated" : "no-pending-run",
      runId: found.runId,
      ...(found.specRef === undefined ? {} : { specRef: found.specRef }),
      proposeBefore: ACCEPT_FINISH_COMMAND,
    };
  }
  if (found.location === "other-session") {
    // Re-suspended in the slot of the session that accepted it earlier. The
    // observer only ever writes to the CURRENT session's ledger, so the run has
    // to come here: park it out of that slot and take it the ordinary way.
    const moved = parkWorkflowRun(
      found.sessionId,
      {
        runId: found.runId,
        ...(found.capture === undefined ? {} : { capture: found.capture }),
        at,
      },
      { env },
    );
    if (moved === null) {
      return {
        status: "no-pending-run",
        message: `run ${found.runId} could not be taken from session ${found.sessionId}`,
      };
    }
  }
  const reactivated = reactivateParkedRun(
    { projectKey, runId: found.runId, sessionId, at },
    { env },
  );
  if (reactivated === null) {
    return {
      status: "no-pending-run",
      message: `run ${found.runId} could not be reactivated`,
    };
  }
  return {
    status: "reactivated",
    runId: reactivated.runId,
    ...(reactivated.specRef === undefined
      ? {}
      : { specRef: reactivated.specRef }),
    proposeBefore: ACCEPT_FINISH_COMMAND,
  };
}

export async function finishAcceptedSpecification(
  { sessionId, skipIntentReason, at = new Date().toISOString() },
  { env = process.env, cwd = process.cwd(), finishRun = finishWorkflowRun } = {},
) {
  const state = liveWorkflowRun(sessionId, { env });
  if (!state?.acceptance) {
    throw new Error(
      "no run awaiting acceptance in this session; run spec accept --path <spec> first",
    );
  }
  const specRef = state.specRef ?? state.acceptance.specRef;
  if (specRef === undefined) {
    throw new Error(`run ${state.runId} has no specification artifact recorded`);
  }
  const absolute = specAbsolutePath(specRef, { repoRoot: state.repoRoot, cwd });
  const artifact = readSpecArtifact(absolute);
  if (artifact === undefined) {
    throw new Error(`the specification ${specRef} does not exist at ${absolute}`);
  }
  const bound = runIsBound(state);
  // The candidate check is the precondition of the draft → accepted transition
  // itself, so it applies whatever the document currently says.
  const gated = applyGates(
    [
      evaluateCandidatesGate(readWorkflowObservations(sessionId, { env }), {
        bound,
        stage: ACCEPT_STAGE,
        spec: artifact,
        specRef,
        required: true,
        ...(skipIntentReason === undefined ? {} : { reason: skipIntentReason }),
      }),
    ],
    { outcome: "success", bound, mode: gateMode(env) },
  );
  // On a refusal nothing is written: the document stays draft and the run stays
  // reactivated, so the remedy is a propose away.
  if (gated.refusal !== undefined) throw new Error(gated.refusal);
  recordWorkflowGates(
    sessionId,
    gated.results.map((entry) => ({ ...entry, at })),
    { env },
  );
  // The acceptance is written only once the run has actually closed: a finish
  // that fails closed (an unfinished declared stage, say) must leave the
  // document a draft and the run reactivated.
  const finished = await finishRun(
    { sessionId, outcome: "success", at },
    {
      env,
      cwd,
      // BR-3 belongs to `finish-run`; this close is gated on its candidates.
      assessCoredocStatus: false,
      // The one caller allowed to end a run awaiting acceptance.
      acceptanceTerminal: true,
      // The run ends through the single `terminateRun` below, which also knows
      // the parked directory; finishing must not remove half of it first.
      finalize: () => null,
    },
  );
  writeSpecArtifactKey(absolute, "status", "accepted");
  // The pointer existed only while the run was waiting for this.
  removeSpecArtifactKey(absolute, "run");
  const terminated = terminateRun(sessionId, state.runId, {
    env,
    ...(state.projectKey === undefined ? {} : { projectKey: state.projectKey }),
  });
  return {
    status: "accepted",
    runId: state.runId,
    specRef,
    terminated: terminated.status,
    gates: gated.results,
    ...(gated.warned === undefined ? {} : { gatesWarned: true }),
    capture: finished.capture,
    ...(finished.history === undefined ? {} : { history: finished.history }),
  };
}

export async function abandonSpecification(
  { sessionId, reason, path, at = new Date().toISOString() },
  { env = process.env, cwd = process.cwd(), finishRun = finishWorkflowRun } = {},
) {
  const projectKey = resolveProjectKey(cwd, env);
  const live = liveWorkflowRun(sessionId, { env });
  const target =
    live?.acceptance !== undefined
      ? {
          runId: live.runId,
          sessionId,
          env,
          repoRoot: live.repoRoot,
          ...(live.specRef === undefined ? {} : { specRef: live.specRef }),
        }
      : parkedAbandonTarget({ projectKey, path, cwd }, { env });
  if (target === undefined) {
    return {
      status: "no-pending-run",
      message: "no run awaiting acceptance for this checkout",
    };
  }
  const state = readWorkflowRun(target.sessionId, { env: target.env });
  const finished = await finishRun(
    { sessionId: target.sessionId, outcome: "abandoned", at },
    {
      env: target.env,
      historyEnv: env,
      historyReason: reason,
      assessCoredocStatus: false,
      acceptanceTerminal: true,
      // One termination for the run, below: a parked run's own finalize sees
      // only its directory's contents, never the directory itself.
      finalize: () => null,
      ...(state?.suspendedEnd
        ? {
            complete: (id, options) =>
              completeWorkflowRun(id, {
                ...options,
                snapshot: () => state.suspendedEnd,
              }),
          }
        : {}),
      ...(target.repoRoot ? { cwd: target.repoRoot } : {}),
    },
  );
  const terminated = terminateRun(target.sessionId, target.runId, {
    env,
    projectKey,
  });
  // The draft keeps its status; only the pointer to the run that is gone goes.
  if (target.specRef !== undefined) {
    removeSpecArtifactKey(
      specAbsolutePath(target.specRef, { repoRoot: target.repoRoot, cwd }),
      "run",
    );
  }
  return {
    status: finished.status === "finished" ? "abandoned" : finished.status,
    runId: target.runId,
    reason,
    terminated: terminated.status,
    capture: finished.capture,
    ...(finished.history === undefined ? {} : { history: finished.history }),
  };
}

function parkedAbandonTarget({ projectKey, path, cwd }, { env }) {
  const parked = listParkedWorkflowRuns({ env, projectKey });
  const specPath = path === undefined ? undefined : normalizedSpecPath(path, cwd);
  const matching =
    specPath === undefined
      ? parked
      : parked.filter(
          (run) =>
            run.specRef !== undefined && specPathFromRef(run.specRef) === specPath,
        );
  if (matching.length === 0) return undefined;
  if (matching.length > 1) {
    throw new Error(
      `${matching.length} runs are awaiting acceptance; name one with --path <spec>: ${matching
        .map((run) => run.specRef ?? run.runId)
        .join(", ")}`,
    );
  }
  const run = matching[0];
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    env: parkedRunEnv(projectKey, run.runId, env),
    repoRoot: run.repoRoot,
    ...(run.specRef === undefined ? {} : { specRef: run.specRef }),
  };
}

async function main() {
  const options = parseSpecArgs(process.argv.slice(2));
  const runtime = resolveWorkflowRuntime();
  const result =
    options.action === "abandon"
      ? await abandonSpecification(
          {
            sessionId: runtime.sessionId,
            reason: options.reason,
            ...(options.path === undefined ? {} : { path: options.path }),
          },
          { env: runtime.env },
        )
      : options.finish
        ? await finishAcceptedSpecification(
            {
              sessionId: runtime.sessionId,
              ...(options.skipIntentReason === undefined
                ? {}
                : { skipIntentReason: options.skipIntentReason }),
            },
            { env: runtime.env },
          )
        : acceptSpecification(
            { sessionId: runtime.sessionId, path: options.path },
            { env: runtime.env },
          );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "no-pending-run") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
