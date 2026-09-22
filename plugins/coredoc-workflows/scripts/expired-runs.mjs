import { createConfiguredCaptureRecorder } from "./capture-client.mjs";
import { captureStateRecorder } from "./capture-state.mjs";
import { captureIdentityEnv, runCaptureEnv } from "./capture-identity.mjs";

// Capture identity lives in its own module now — `capture-client.mjs` is pinned
// by the runtime manifest — and is re-exported here for existing callers.
import { finishWorkflowRun } from "./finish-run.mjs";
import {
  claimExpiredWorkflowRun,
  completeWorkflowRun,
  listParkedWorkflowRuns,
  listSuspendedWorkflowRuns,
  parkedRunEnv,
  terminateRun,
} from "./workflow-run-state.mjs";

export { captureIdentityEnv, runCaptureEnv };

// A suspended run whose session never came back is abandoned by the next
// router that notices. Long enough to outlast a weekend; the record then
// carries the suspension time, not the discovery time.
const SUSPENDED_RUN_TTL_MS = 72 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A run waiting for a user's acceptance waits far longer than one waiting for
// a session to come back, and says so on its own state.
const ACCEPTANCE_TTL_DAYS = 14;
// A claim older than this belongs to a sweeper that died mid-finish; the run
// may be taken again, at the cost of a possible duplicate finish event.
const STALE_CLAIM_MS = 10 * 60 * 1000;
// Each expiry snapshots a repository and attempts delivery; the router must
// stay responsive even after a long absence.
const MAX_EXPIRED_RUNS_PER_SWEEP = 5;
const DISABLED_ARTIFACTS = { status: "disabled", queued: 0, sent: 0, pending: 0 };
function queueStageCapture(event, { env, sessionId, projectKey }) {
  try {
    const queued = createConfiguredCaptureRecorder({
      env,
      sessionId,
      // The expiry's stage event carries delivery state like any other.
      createRecorder: captureStateRecorder({ projectKey, env }),
    }).record(event);
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
  { ownSessionId, projectKey, now = Date.now() } = {},
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
        {
          now,
          ttlMs: Number.isInteger(run.ttlDays) ? run.ttlDays * DAY_MS : ttlMs,
          staleClaimMs: STALE_CLAIM_MS,
        },
        { env },
      );
      if (!claimed) continue;
      const { state, stageEvent } = claimed;
      const runEnv = runCaptureEnv(env, state.capture);
      const stageCapture =
        stageEvent === null
          ? null
          : queueStage(stageEvent, {
              env: runEnv,
              sessionId: state.sessionId,
              projectKey: state.projectKey,
            });
      const finished = await finishRun(
        { sessionId: state.sessionId, outcome: "abandoned", at: state.suspendedAt },
        {
          env: runEnv,
          timeoutMs: 750,
          // A run that was waiting for a user's acceptance says so in the
          // durable history, wherever the sweep happened to find it.
          ...(state.acceptance
            ? { historyEnv: env, historyOutcome: "acceptance-expired" }
            : {}),
          // The repository as the session left it, not as it is days later.
          complete: (sessionId, options) =>
            completeWorkflowRun(sessionId, {
              ...options,
              ...(state.suspendedEnd ? { useSuspendedSnapshots: true } : {}),
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
        ...(state.acceptance ? { reason: "acceptance-expired" } : {}),
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
  return [
    ...expired,
    ...(await abandonExpiredParkedRuns(
      { projectKey, now, limit: MAX_EXPIRED_RUNS_PER_SWEEP - expired.length },
      { env, finishRun },
    )),
  ];
}

/**
 * Runs parked out of their session slot waiting for an acceptance that never
 * came (BR-5). Each is addressed through its own directory, so the ordinary
 * claim/finish path applies unchanged; the abandonment is recorded at the
 * suspension time under the run's own binding and capture identity, and the
 * durable history says the TTL, not a session, ended it.
 */
async function abandonExpiredParkedRuns(
  { projectKey, now, limit },
  { env, finishRun },
) {
  const expired = [];
  if (limit <= 0) return expired;
  for (const run of listParkedWorkflowRuns({ env, projectKey })) {
    if (expired.length >= limit) break;
    const runTtlMs =
      (Number.isInteger(run.ttlDays) ? run.ttlDays : ACCEPTANCE_TTL_DAYS) * DAY_MS;
    if (Date.parse(run.parkedAt) + runTtlMs > now) continue;
    const runEnv = parkedRunEnv(projectKey, run.runId, env);
    try {
      const claimed = claimExpiredWorkflowRun(
        run.sessionId,
        { now, ttlMs: runTtlMs, staleClaimMs: STALE_CLAIM_MS },
        { env: runEnv },
      );
      if (!claimed) continue;
      const { state } = claimed;
      const finished = await finishRun(
        {
          sessionId: state.sessionId,
          outcome: "abandoned",
          at: state.suspendedAt,
        },
        {
          env: runCaptureEnv(runEnv, state.capture),
          timeoutMs: 750,
          historyEnv: env,
          historyOutcome: "acceptance-expired",
          complete: (sessionId, options) =>
            completeWorkflowRun(sessionId, {
              ...options,
              ...(state.suspendedEnd ? { useSuspendedSnapshots: true } : {}),
            }),
          ...(state.repoRoot
            ? { cwd: state.repoRoot }
            : { checkpointArtifacts: async () => DISABLED_ARTIFACTS }),
        },
      );
      terminateRun(state.sessionId, run.runId, { env, projectKey });
      expired.push({
        runId: run.runId,
        sessionId: state.sessionId,
        status: finished.status,
        reason: "acceptance-expired",
      });
    } catch (error) {
      expired.push({
        runId: run.runId,
        sessionId: run.sessionId,
        status: "failed",
        reason: "acceptance-expired",
        message: error.message,
      });
    }
  }
  return expired;
}
