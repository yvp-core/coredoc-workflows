import { createConfiguredCaptureRecorder } from "./capture-client.mjs";
import { finishWorkflowRun } from "./finish-run.mjs";
import {
  claimExpiredWorkflowRun,
  completeWorkflowRun,
  listSuspendedWorkflowRuns,
} from "./workflow-run-state.mjs";

// A suspended run whose session never came back is abandoned by the next
// router that notices. Long enough to outlast a weekend; the record then
// carries the suspension time, not the discovery time.
const SUSPENDED_RUN_TTL_MS = 72 * 60 * 60 * 1000;
// A claim older than this belongs to a sweeper that died mid-finish; the run
// may be taken again, at the cost of a possible duplicate finish event.
const STALE_CLAIM_MS = 10 * 60 * 1000;
// Each expiry snapshots a repository and attempts delivery; the router must
// stay responsive even after a long absence.
const MAX_EXPIRED_RUNS_PER_SWEEP = 5;
const DISABLED_ARTIFACTS = { status: "disabled", queued: 0, sent: 0, pending: 0 };
const CAPTURE_ENV_PREFIX = "COREDOC_CAPTURE_";
const CAPTURE_ENV_KEYS = new Set([
  "COREDOC_WORKFLOWS_REPO_KEY",
  "COREDOC_WORKFLOWS_CAPTURE_DIR",
]);

function isCaptureEnvKey(key) {
  return key.startsWith(CAPTURE_ENV_PREFIX) || CAPTURE_ENV_KEYS.has(key);
}

/** The variables that decide where and as whom a capture event is recorded. */
export function captureIdentityEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => isCaptureEnvKey(key) && typeof value === "string",
    ),
  );
}

// The run is recorded under the identity its own session persisted when it
// was suspended. The router's identity is removed first, so a run suspended
// without capture stays uncaptured instead of borrowing the router's binding.
function runCaptureEnv(env, capture) {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => !isCaptureEnvKey(key)),
    ),
    ...(capture && typeof capture === "object" ? capture : {}),
  };
}

function queueStageCapture(event, { env, sessionId }) {
  try {
    const queued = createConfiguredCaptureRecorder({ env, sessionId }).record(
      event,
    );
    return {
      ...queued,
      durable: queued.status === "queued" || queued.status === "disabled",
    };
  } catch {
    // Deliberate best-effort: the stage record must never keep the run from
    // being recorded abandoned.
    return { status: "failed", durable: false };
  }
}

/**
 * Abandon expired runs of other sessions. Runs from the router because
 * SessionStart has no resolved capture environment yet. A failure on one run
 * is reported and the sweep continues; nothing here may fail the route.
 */
export async function abandonExpiredWorkflowRuns(
  { ownSessionId, now = Date.now() } = {},
  {
    env = process.env,
    ttlMs = SUSPENDED_RUN_TTL_MS,
    finishRun = finishWorkflowRun,
    queueStage = queueStageCapture,
  } = {},
) {
  const expired = [];
  for (const run of listSuspendedWorkflowRuns({ env })) {
    if (expired.length >= MAX_EXPIRED_RUNS_PER_SWEEP) break;
    if (run.sessionId === ownSessionId) continue;
    try {
      const claimed = claimExpiredWorkflowRun(
        run.sessionId,
        { now, ttlMs, staleClaimMs: STALE_CLAIM_MS },
        { env },
      );
      if (!claimed) continue;
      const { state, stageEvent } = claimed;
      const runEnv = runCaptureEnv(env, state.capture);
      const stageCapture =
        stageEvent === null
          ? null
          : queueStage(stageEvent, { env: runEnv, sessionId: state.sessionId });
      const finished = await finishRun(
        { sessionId: state.sessionId, outcome: "abandoned", at: state.suspendedAt },
        {
          env: runEnv,
          timeoutMs: 750,
          // The repository as the session left it, not as it is days later.
          complete: (sessionId, options) =>
            completeWorkflowRun(sessionId, {
              ...options,
              ...(state.suspendedEnd ? { snapshot: () => state.suspendedEnd } : {}),
            }),
          // Artifacts belong to the run's own repository, never to the one that
          // happens to route next; without a known root nothing is checkpointed.
          ...(state.repoRoot
            ? { cwd: state.repoRoot }
            : { checkpointArtifacts: async () => DISABLED_ARTIFACTS }),
        },
      );
      expired.push({
        runId: state.runId,
        sessionId: state.sessionId,
        status: finished.status,
        ...(stageCapture === null ? {} : { stageCapture: stageCapture.status }),
      });
    } catch (error) {
      expired.push({
        runId: run.runId,
        sessionId: run.sessionId,
        status: "failed",
        message: error.message,
      });
    }
  }
  return expired;
}
