/**
 * Where and as whom a workflow record is filed.
 *
 * Its own module rather than part of `capture-client.mjs`: that file is pinned
 * by the capture agent's runtime manifest (`runtime/capture-agent-manifest.json`),
 * so editing it would invalidate the verified runtime closure. Nothing here
 * performs capture — it only reads the ambient binding and restores a run's own.
 */

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

/**
 * Record a run under the identity its own session persisted, not under the
 * identity of whichever session runs the command. The ambient identity is
 * removed first, so a run stored without one stays uncaptured instead of
 * borrowing the caller's binding.
 */
export function runCaptureEnv(env, capture) {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => !isCaptureEnvKey(key)),
    ),
    ...(capture && typeof capture === "object" ? capture : {}),
  };
}

/**
 * The repository a run is in, as the local binding knows it, or `unmapped`.
 * Same source as `createConfiguredCaptureRecorder`'s context, made explicit for
 * the gates, which must tell "no repository" apart from "repository unknown".
 */
export function captureRepositoryKey(env = process.env) {
  const key =
    env.COREDOC_CAPTURE_WORKSPACE_MODE === "1"
      ? env.COREDOC_CAPTURE_REPOSITORY_CANDIDATE_KEY
      : env.COREDOC_WORKFLOWS_REPO_KEY;
  return typeof key === "string" && key !== "" ? key : "unmapped";
}

/** Whether this checkout is enrolled to a workspace at all (DEC-2). */
export function captureIsBound(env = process.env) {
  return (
    typeof env.COREDOC_CAPTURE_WORKSPACE_ID === "string" &&
    env.COREDOC_CAPTURE_WORKSPACE_ID !== ""
  );
}
