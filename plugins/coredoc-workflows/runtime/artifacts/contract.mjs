const TASK_ID_RE =
  /^cdt_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const ARTIFACT_ID_RE =
  /^cda_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID_RE = /^cdr-\d{8}-[0-9a-f]{6}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPOSITORY_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const ARTIFACT_MARKDOWN_MAX_BYTES = 1_048_576;
export const ARTIFACT_KINDS = Object.freeze([
  "spec",
  "design",
  "implementation_issue",
]);
export const ARTIFACT_CHECKPOINTS = Object.freeze([
  "run-finish",
  "session-end",
  "session-start-reconcile",
]);

const KINDS = new Set(ARTIFACT_KINDS);
const CHECKPOINTS = new Set(ARTIFACT_CHECKPOINTS);
const LIFECYCLES = new Set(["active", "completed", "abandoned"]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exact(value, allowed, label) {
  const candidate = object(value, label);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) throw new Error(`unsupported ${label} field`);
  }
  return candidate;
}

function boundedString(value, maximum, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function canonicalTaskId(value) {
  if (typeof value !== "string" || !TASK_ID_RE.test(value)) {
    throw new Error("task ID is invalid");
  }
  return value;
}

export function canonicalArtifactId(value) {
  if (typeof value !== "string" || !ARTIFACT_ID_RE.test(value)) {
    throw new Error("artifact ID is invalid");
  }
  return value;
}

export function canonicalRepositoryKey(value) {
  if (typeof value !== "string" || value.length > 256) {
    throw new Error("repository key is invalid");
  }
  const segments = value.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !REPOSITORY_SEGMENT_RE.test(segment),
    )
  ) {
    throw new Error("repository key is invalid");
  }
  return value;
}

export function artifactKind(value) {
  if (!KINDS.has(value)) throw new Error("artifact kind is invalid");
  return value;
}

export function artifactCheckpoint(value) {
  if (!CHECKPOINTS.has(value)) throw new Error("artifact checkpoint is invalid");
  return value;
}

export function artifactMarkdown(value) {
  if (typeof value !== "string") {
    throw new Error("artifact Markdown is invalid");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("artifact Markdown is invalid");
      }
      index += 1;
      continue;
    }
    if (
      (code >= 0xdc00 && code <= 0xdfff) ||
      (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      throw new Error("artifact Markdown is invalid");
    }
  }
  if (Buffer.byteLength(value) > ARTIFACT_MARKDOWN_MAX_BYTES) {
    throw new Error("artifact Markdown is invalid");
  }
  return value;
}

export function taskEnsureRequest(input) {
  const candidate = exact(
    input,
    new Set(["repositoryKey"]),
    "task ensure request",
  );
  return { repositoryKey: canonicalRepositoryKey(candidate.repositoryKey) };
}

export function artifactRevisionRequest(input) {
  const candidate = exact(
    input,
    new Set([
      "taskId",
      "repositoryKey",
      "kind",
      "runId",
      "checkpoint",
      "markdown",
    ]),
    "artifact revision request",
  );
  const markdown = artifactMarkdown(candidate.markdown);
  if (
    candidate.runId !== undefined &&
    (typeof candidate.runId !== "string" || !RUN_ID_RE.test(candidate.runId))
  ) {
    throw new Error("run ID is invalid");
  }
  return {
    taskId: canonicalTaskId(candidate.taskId),
    repositoryKey: canonicalRepositoryKey(candidate.repositoryKey),
    kind: artifactKind(candidate.kind),
    ...(candidate.runId === undefined ? {} : { runId: candidate.runId }),
    checkpoint: artifactCheckpoint(candidate.checkpoint),
    markdown,
  };
}

function externalRef(value) {
  const candidate = exact(
    value,
    new Set([
      "provider",
      "externalId",
      "externalKey",
      "externalUrl",
      "externalState",
    ]),
    "external reference",
  );
  return {
    provider: boundedString(candidate.provider, 64, "external provider"),
    externalId: boundedString(candidate.externalId, 256, "external ID"),
    externalKey:
      candidate.externalKey === null
        ? null
        : boundedString(candidate.externalKey, 256, "external key"),
    externalUrl:
      candidate.externalUrl === null
        ? null
        : boundedString(candidate.externalUrl, 2_048, "external URL"),
    externalState:
      candidate.externalState === null
        ? null
        : boundedString(candidate.externalState, 128, "external state"),
  };
}

export function taskEnsureResponse(input, expected) {
  const candidate = exact(
    input,
    new Set(["id", "repositoryKey", "lifecycle", "authority", "externalRefs"]),
    "task ensure response",
  );
  if (
    !Array.isArray(candidate.externalRefs) ||
    candidate.externalRefs.length > 32
  ) {
    throw new Error("external references are invalid");
  }
  const parsed = {
    id: canonicalTaskId(candidate.id),
    repositoryKey: canonicalRepositoryKey(candidate.repositoryKey),
    lifecycle: LIFECYCLES.has(candidate.lifecycle)
      ? candidate.lifecycle
      : (() => {
          throw new Error("task lifecycle is invalid");
        })(),
    authority:
      candidate.authority === "coredoc" ||
      (typeof candidate.authority === "string" &&
        /^connector:[a-z][a-z0-9._-]{0,63}$/.test(candidate.authority))
        ? candidate.authority
        : (() => {
            throw new Error("task authority is invalid");
          })(),
    externalRefs: candidate.externalRefs.map(externalRef),
  };
  if (
    parsed.id !== expected.taskId ||
    parsed.repositoryKey !== expected.repositoryKey
  ) {
    throw new Error("task ensure response does not match");
  }
  return parsed;
}

export function artifactRevisionResponse(input, expected) {
  const candidate = exact(
    input,
    new Set(["status", "artifact", "revision"]),
    "artifact revision response",
  );
  if (candidate.status !== "accepted" && candidate.status !== "duplicate") {
    throw new Error("artifact revision status is invalid");
  }
  const artifact = exact(
    candidate.artifact,
    new Set(["id", "taskId", "repositoryKey", "kind"]),
    "artifact identity",
  );
  const revision = exact(
    candidate.revision,
    new Set([
      "id",
      "sha256",
      "byteCount",
      "checkpoint",
      "runId",
      "createdAt",
    ]),
    "artifact revision",
  );
  const parsed = {
    status: candidate.status,
    artifact: {
      id: canonicalArtifactId(artifact.id),
      taskId: canonicalTaskId(artifact.taskId),
      repositoryKey: canonicalRepositoryKey(artifact.repositoryKey),
      kind: artifactKind(artifact.kind),
    },
    revision: {
      id:
        typeof revision.id === "string" && UUID_RE.test(revision.id)
          ? revision.id
          : (() => {
              throw new Error("revision ID is invalid");
            })(),
      sha256:
        typeof revision.sha256 === "string" && SHA256_RE.test(revision.sha256)
          ? revision.sha256
          : (() => {
              throw new Error("revision digest is invalid");
            })(),
      byteCount:
        Number.isInteger(revision.byteCount) &&
        revision.byteCount >= 0 &&
        revision.byteCount <= ARTIFACT_MARKDOWN_MAX_BYTES
          ? revision.byteCount
          : (() => {
              throw new Error("revision byte count is invalid");
            })(),
      checkpoint: artifactCheckpoint(revision.checkpoint),
      runId:
        revision.runId === null ||
        (typeof revision.runId === "string" && RUN_ID_RE.test(revision.runId))
          ? revision.runId
          : (() => {
              throw new Error("revision run ID is invalid");
            })(),
      createdAt:
        typeof revision.createdAt === "string" &&
        ISO_TIMESTAMP_RE.test(revision.createdAt) &&
        !Number.isNaN(Date.parse(revision.createdAt))
          ? revision.createdAt
          : (() => {
              throw new Error("revision timestamp is invalid");
            })(),
    },
  };
  if (
    parsed.artifact.id !== expected.artifactId ||
    parsed.artifact.taskId !== expected.body.taskId ||
    parsed.artifact.repositoryKey !== expected.body.repositoryKey ||
    parsed.artifact.kind !== expected.body.kind ||
    parsed.revision.sha256 !== expected.digest ||
    parsed.revision.byteCount !== Buffer.byteLength(expected.body.markdown) ||
    (parsed.status === "accepted" &&
      (parsed.revision.checkpoint !== expected.body.checkpoint ||
        parsed.revision.runId !== (expected.body.runId ?? null)))
  ) {
    throw new Error("artifact revision response does not match");
  }
  return parsed;
}

export function deliveryRoute(pathname) {
  if (typeof pathname !== "string" || pathname.length > 256) return null;
  let match = /^\/delivery\/v2\/tasks\/(cdt_[0-9a-f-]+)$/.exec(pathname);
  if (match) {
    try {
      return { kind: "task", taskId: canonicalTaskId(match[1]) };
    } catch {
      return null;
    }
  }
  match =
    /^\/delivery\/v2\/artifacts\/(cda_[0-9a-f-]+)\/revisions$/.exec(
      pathname,
    );
  if (match) {
    try {
      return { kind: "artifact", artifactId: canonicalArtifactId(match[1]) };
    } catch {
      return null;
    }
  }
  return null;
}
