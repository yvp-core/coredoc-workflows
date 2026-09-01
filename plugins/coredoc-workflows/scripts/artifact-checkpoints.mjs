import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  ARTIFACT_CHECKPOINTS,
  ARTIFACT_KINDS,
  ARTIFACT_MARKDOWN_MAX_BYTES,
  artifactMarkdown,
  artifactRevisionRequest,
  artifactRevisionResponse,
  canonicalArtifactId,
  canonicalRepositoryKey,
  canonicalTaskId,
  taskEnsureRequest,
  taskEnsureResponse,
} from "../runtime/artifacts/contract.mjs";
import {
  managedCaptureBindingStorageHash,
  relayBindingNonceFromCaptureHeaders,
  sha256BindingNonce,
} from "./managed-otel-relay.mjs";
import {
  RepositoryUnavailableError,
  requireRepositoryCandidate,
  resolveRepositoryIdentity,
  stateRoot,
} from "./project-key.mjs";

const CONFIG_RELATIVE_PATH = join(
  ".coredoc",
  "delivery-observability.json",
);
const CONFIG_MAX_BYTES = 64 * 1024;
const JSON_MAX_BYTES = 3 * 1024 * 1024;
const MAX_CONFIG_ENTRIES = 16;
const MAX_MATCHED_ARTIFACTS = 16;
const MAX_OUTBOX_ENTRIES = 16;
const MAX_DIGEST_ENTRIES = 16;
const MAX_QUARANTINE_ENTRIES = 16;
const MAX_DIRECTORY_SCAN_ENTRIES = 512;
const MANAGED_ENDPOINT = "http://127.0.0.1:43181/capture/v1/events";
const BINDING_HASH_RE = /^[0-9a-f]{64}$/;
const BINDING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANAGED_INGRESS_RE = /^[A-Za-z0-9_-]{32,256}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const STATE_NAME = "state.json";
const OUTBOX_NAME_RE =
  /^revision-(\d{6})-(cda_[0-9a-f-]+)-([0-9a-f]{64})\.json$/;
const QUARANTINE_NAME_RE =
  /^quarantine-(\d{6})-(cda_[0-9a-f-]+)-([0-9a-f]{64})\.json$/;

const GLOB_KIND = new Map([
  [".scratch/*/spec.md", "spec"],
  [".scratch/*/design.md", "design"],
  [".scratch/*/issues/*.md", "implementation_issue"],
]);
const HEALTH_ERROR_CODES = new Set([
  "AUTH_REJECTED",
  "OUTBOX_OVERFLOW",
  "REPOSITORY_UNAVAILABLE",
  "TRANSPORT_UNAVAILABLE",
  "CONFIG_CONFLICT",
]);

export class ArtifactCheckpointError extends Error {
  constructor(code) {
    super(code);
    this.name = "ArtifactCheckpointError";
    this.code = code;
  }
}

function fail(code = "CONFIG_CONFLICT") {
  throw new ArtifactCheckpointError(code);
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if (Object.keys(value).some((field) => !fields.has(field))) fail();
  return value;
}

function deadline(deadlineAt, now) {
  if (deadlineAt !== undefined && now() >= deadlineAt) {
    fail("DEADLINE_EXCEEDED");
  }
}

function contained(root, path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (
    resolvedPath !== resolvedRoot &&
    !resolvedPath.startsWith(`${resolvedRoot}${sep}`)
  ) {
    fail();
  }
  return { resolvedRoot, resolvedPath };
}

function rejectSymlinkSegments(root, path) {
  const { resolvedRoot, resolvedPath } = contained(root, path);
  const segments = relative(resolvedRoot, resolvedPath).split(sep).filter(Boolean);
  let current = resolvedRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) fail();
  }
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail();
  }
}

function readBoundedFile(path, { root, maximum, mode } = {}) {
  let descriptor;
  try {
    rejectSymlinkSegments(root, path);
    const canonical = realpathSync(path);
    const resolvedRoot = realpathSync(resolve(root));
    if (
      canonical !== resolvedRoot &&
      !canonical.startsWith(`${resolvedRoot}${sep}`)
    ) {
      fail();
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size > maximum ||
      (mode !== undefined && (metadata.mode & 0o777) !== mode)
    ) {
      fail();
    }
    const buffer = readFileSync(descriptor);
    if (buffer.byteLength > maximum) fail();
    return buffer;
  } catch (error) {
    if (error instanceof ArtifactCheckpointError) throw error;
    fail();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readJson(path, options) {
  try {
    return JSON.parse(decodeUtf8(readBoundedFile(path, options)));
  } catch (error) {
    if (error instanceof ArtifactCheckpointError) throw error;
    fail();
  }
}

function artifactConfig(value) {
  const candidate = exactObject(value, new Set(["schemaVersion", "artifacts"]));
  if (
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.artifacts) ||
    candidate.artifacts.length > MAX_CONFIG_ENTRIES
  ) {
    fail();
  }
  const artifacts = candidate.artifacts.map((entry) => {
    const item = exactObject(entry, new Set(["glob", "kind"]));
    if (
      typeof item.glob !== "string" ||
      typeof item.kind !== "string" ||
      GLOB_KIND.get(item.glob) !== item.kind
    ) {
      fail();
    }
    return { glob: item.glob, kind: item.kind };
  });
  if (new Set(artifacts.map(({ glob }) => glob)).size !== artifacts.length) {
    fail();
  }
  return { schemaVersion: 1, artifacts };
}

export function parseCoredocFrontmatter(markdown) {
  if (typeof markdown !== "string" || !markdown.startsWith("---\n")) fail();
  const closing = markdown.indexOf("\n---\n", 4);
  if (closing < 0 || closing > 64 * 1024) fail();
  const lines = markdown.slice(4, closing).split("\n");
  const starts = lines
    .map((line, index) => (line === "coredoc:" ? index : -1))
    .filter((index) => index >= 0);
  if (starts.length !== 1) fail();
  const values = {};
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("  ")) break;
    const match = /^  (task_id|artifact_id|kind): ([^\s].*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) fail();
    values[match[1]] = match[2];
  }
  if (Object.keys(values).length !== 3) fail();
  try {
    return {
      taskId: canonicalTaskId(values.task_id),
      artifactId: canonicalArtifactId(values.artifact_id),
      kind:
        ARTIFACT_KINDS.includes(values.kind) && values.kind
          ? values.kind
          : fail(),
    };
  } catch (error) {
    if (error instanceof ArtifactCheckpointError) throw error;
    fail();
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedEntries(path, maximum = MAX_DIRECTORY_SCAN_ENTRIES) {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
      compareText(left.name, right.name),
    );
  } catch {
    fail();
  }
  if (entries.length > maximum) fail();
  return entries;
}

function candidatePaths(root, config, deadlineAt, now) {
  const scratch = join(root, ".scratch");
  if (!existsSync(scratch)) return [];
  rejectSymlinkSegments(root, scratch);
  if (!lstatSync(scratch).isDirectory()) fail();
  const featureEntries = sortedEntries(scratch);
  const candidates = new Map();
  const remember = (path, kind) => {
    let modifiedAt;
    try {
      modifiedAt = lstatSync(path).mtimeMs;
    } catch {
      fail();
    }
    candidates.set(path, { kind, modifiedAt });
    if (candidates.size <= MAX_MATCHED_ARTIFACTS) return;
    const oldest = [...candidates.entries()].sort(
      ([leftPath, left], [rightPath, right]) =>
        left.modifiedAt - right.modifiedAt || compareText(rightPath, leftPath),
    )[0][0];
    candidates.delete(oldest);
  };
  for (const feature of featureEntries) {
    deadline(deadlineAt, now);
    if (feature.isSymbolicLink()) fail();
    if (!feature.isDirectory()) continue;
    const featureRoot = join(scratch, feature.name);
    for (const entry of config.artifacts) {
      if (entry.glob === ".scratch/*/issues/*.md") {
        const issues = join(featureRoot, "issues");
        if (!existsSync(issues)) continue;
        rejectSymlinkSegments(root, issues);
        if (!lstatSync(issues).isDirectory()) fail();
        for (const issue of sortedEntries(issues)) {
          deadline(deadlineAt, now);
          if (issue.isSymbolicLink() && issue.name.endsWith(".md")) fail();
          if (!issue.isFile() || !issue.name.endsWith(".md")) continue;
          const path = join(issues, issue.name);
          remember(path, entry.kind);
        }
        continue;
      }
      const path = join(
        featureRoot,
        entry.glob === ".scratch/*/spec.md" ? "spec.md" : "design.md",
      );
      if (existsSync(path)) {
        remember(path, entry.kind);
      }
    }
  }
  return [...candidates.entries()]
    .sort(
      ([leftPath, left], [rightPath, right]) =>
        right.modifiedAt - left.modifiedAt || compareText(leftPath, rightPath),
    )
    .map(([path, { kind }]) => [path, kind]);
}

export function discoverConfiguredArtifacts({
  cwd = process.cwd(),
  deadlineAt,
  now = Date.now,
} = {}) {
  const root = realpathSync(resolve(cwd));
  const configPath = join(root, CONFIG_RELATIVE_PATH);
  if (!existsSync(configPath)) return [];
  deadline(deadlineAt, now);
  const config = artifactConfig(
    readJson(configPath, { root, maximum: CONFIG_MAX_BYTES }),
  );
  const artifacts = [];
  const identities = new Set();
  for (const [path, configuredKind] of candidatePaths(
    root,
    config,
    deadlineAt,
    now,
  )) {
    deadline(deadlineAt, now);
    const markdown = decodeUtf8(
      readBoundedFile(path, {
        root,
        maximum: ARTIFACT_MARKDOWN_MAX_BYTES,
      }),
    );
    const metadata = parseCoredocFrontmatter(markdown);
    try {
      artifactMarkdown(markdown);
    } catch {
      fail();
    }
    if (metadata.kind !== configuredKind || identities.has(metadata.artifactId)) {
      fail();
    }
    identities.add(metadata.artifactId);
    artifacts.push({ ...metadata, markdown });
  }
  return artifacts;
}

function ensureDirectory(path) {
  const parent = dirname(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (basename(parent) === "artifact-outbox") {
    const relayRoot = dirname(parent);
    for (const candidate of [relayRoot, parent]) {
      const candidateMetadata = lstatSync(candidate);
      if (
        !candidateMetadata.isDirectory() ||
        candidateMetadata.isSymbolicLink()
      ) {
        fail();
      }
    }
    chmodSync(parent, 0o700);
  }
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail();
  chmodSync(path, 0o700);
}

function atomicJson(path, value) {
  const directory = dirname(path);
  ensureDirectory(directory);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeSync(descriptor, `${JSON.stringify(value)}\n`, undefined, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // The bounded caller will retain the previous durable state.
    }
    if (error instanceof ArtifactCheckpointError) throw error;
    fail();
  }
}

function initialState() {
  return {
    schemaVersion: 1,
    nextSequence: 1,
    artifacts: {},
    quarantined: [],
    errorCode: null,
  };
}

function quarantinedCheckpoint(value) {
  const candidate = exactObject(
    value,
    new Set(["sequence", "artifactId", "digest", "errorCode"]),
  );
  let artifactId;
  try {
    artifactId = canonicalArtifactId(candidate.artifactId);
  } catch {
    fail();
  }
  if (
    !Number.isInteger(candidate.sequence) ||
    candidate.sequence < 1 ||
    candidate.sequence > 999_999 ||
    typeof candidate.digest !== "string" ||
    !DIGEST_RE.test(candidate.digest) ||
    candidate.errorCode !== "CONFIG_CONFLICT"
  ) {
    fail();
  }
  return {
    sequence: candidate.sequence,
    artifactId,
    digest: candidate.digest,
    errorCode: "CONFIG_CONFLICT",
  };
}

function checkpointState(value) {
  const candidate = exactObject(
    value,
    new Set([
      "schemaVersion",
      "nextSequence",
      "artifacts",
      "quarantined",
      "errorCode",
    ]),
  );
  const rawQuarantined = candidate.quarantined ?? [];
  if (!Array.isArray(rawQuarantined)) fail();
  const quarantined = rawQuarantined.map(quarantinedCheckpoint);
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isInteger(candidate.nextSequence) ||
    candidate.nextSequence < 1 ||
    candidate.nextSequence > 999_999 ||
    !candidate.artifacts ||
    typeof candidate.artifacts !== "object" ||
    Array.isArray(candidate.artifacts) ||
    Object.keys(candidate.artifacts).length > MAX_DIGEST_ENTRIES ||
    quarantined.length > MAX_QUARANTINE_ENTRIES ||
    new Set(quarantined.map(({ sequence }) => sequence)).size !==
      quarantined.length ||
    (candidate.errorCode !== null &&
      !HEALTH_ERROR_CODES.has(candidate.errorCode))
  ) {
    fail();
  }
  const artifacts = {};
  for (const [artifactId, digest] of Object.entries(candidate.artifacts)) {
    try {
      canonicalArtifactId(artifactId);
    } catch {
      fail();
    }
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) fail();
    artifacts[artifactId] = digest;
  }
  return {
    schemaVersion: 1,
    nextSequence: candidate.nextSequence,
    artifacts,
    quarantined,
    errorCode: candidate.errorCode,
  };
}

function readState(directory) {
  const path = join(directory, STATE_NAME);
  if (!existsSync(path)) return initialState();
  return checkpointState(
    readJson(path, { root: directory, maximum: CONFIG_MAX_BYTES, mode: 0o600 }),
  );
}

function outboxRecord(value) {
  const candidate = exactObject(
    value,
    new Set(["schemaVersion", "sequence", "artifactId", "digest", "body"]),
  );
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isInteger(candidate.sequence) ||
    candidate.sequence < 1 ||
    candidate.sequence > 999_999 ||
    typeof candidate.digest !== "string" ||
    !DIGEST_RE.test(candidate.digest)
  ) {
    fail();
  }
  let artifactId;
  let body;
  try {
    artifactId = canonicalArtifactId(candidate.artifactId);
    body = artifactRevisionRequest(candidate.body);
  } catch {
    fail();
  }
  const digest = createHash("sha256").update(body.markdown).digest("hex");
  if (digest !== candidate.digest) fail();
  return {
    schemaVersion: 1,
    sequence: candidate.sequence,
    artifactId,
    digest,
    body,
  };
}

function pendingRecords(directory) {
  if (!existsSync(directory)) return [];
  const metadata = lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    fail();
  }
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(({ name }) => name.startsWith("revision-"))
    .sort((left, right) => compareText(left.name, right.name));
  if (entries.length > MAX_OUTBOX_ENTRIES) fail();
  return entries.map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink()) fail();
    const match = OUTBOX_NAME_RE.exec(entry.name);
    if (!match) fail();
    const record = outboxRecord(
      readJson(join(directory, entry.name), {
        root: directory,
        maximum: JSON_MAX_BYTES,
        mode: 0o600,
      }),
    );
    if (
      record.sequence !== Number(match[1]) ||
      record.artifactId !== match[2] ||
      record.digest !== match[3]
    ) {
      fail();
    }
    Object.defineProperty(record, "entryName", {
      value: entry.name,
      enumerable: false,
    });
    return record;
  });
}

export function artifactCheckpointDirectory(relayRoot, bindingNonceHash) {
  if (!BINDING_HASH_RE.test(String(bindingNonceHash ?? ""))) fail();
  const root = resolve(relayRoot);
  const directory = resolve(root, "artifact-outbox", bindingNonceHash);
  if (!directory.startsWith(`${root}${sep}`)) fail();
  return directory;
}

export function createArtifactCheckpointStore({ directory } = {}) {
  if (typeof directory !== "string" || directory.length === 0) fail();
  ensureDirectory(directory);
  const statePath = join(directory, STATE_NAME);

  function state() {
    return readState(directory);
  }

  function writeState(value) {
    atomicJson(statePath, checkpointState(value));
  }

  function pending() {
    return pendingRecords(directory);
  }

  function markError(errorCode) {
    const current = state();
    writeState({
      ...current,
      errorCode,
    });
  }

  return {
    directory,
    state,
    pending,
    enqueue(input) {
      let artifactId;
      let body;
      try {
        artifactId = canonicalArtifactId(input?.artifactId);
        body = artifactRevisionRequest(input?.body);
      } catch {
        fail();
      }
      const digest = createHash("sha256").update(body.markdown).digest("hex");
      if (input?.digest !== digest) fail();
      const currentPending = pending();
      const existing = currentPending.find(
        (record) =>
          record.artifactId === artifactId && record.digest === digest,
      );
      if (existing) {
        const current = state();
        if (current.nextSequence <= existing.sequence) {
          writeState({ ...current, nextSequence: existing.sequence + 1 });
        }
        return { status: "queued", pending: currentPending.length };
      }
      if (currentPending.length >= MAX_OUTBOX_ENTRIES) {
        markError("OUTBOX_OVERFLOW");
        return { status: "overflow", pending: currentPending.length };
      }
      const current = state();
      const sequence = current.nextSequence;
      const record = {
        schemaVersion: 1,
        sequence,
        artifactId,
        digest,
        body,
      };
      const name = `revision-${String(sequence).padStart(6, "0")}-${artifactId}-${digest}.json`;
      atomicJson(join(directory, name), record);
      writeState({
        ...current,
        nextSequence: sequence + 1,
        errorCode: null,
      });
      return { status: "queued", pending: currentPending.length + 1 };
    },
    markQueued(artifactId, digest) {
      try {
        canonicalArtifactId(artifactId);
      } catch {
        fail();
      }
      if (!DIGEST_RE.test(String(digest ?? ""))) fail();
      const current = state();
      writeState({
        ...current,
        artifacts: { ...current.artifacts, [artifactId]: digest },
      });
    },
    reconcileArtifacts(artifactIds) {
      if (!Array.isArray(artifactIds) || artifactIds.length > MAX_DIGEST_ENTRIES) {
        fail();
      }
      const active = new Set();
      try {
        for (const artifactId of artifactIds) {
          active.add(canonicalArtifactId(artifactId));
        }
      } catch {
        fail();
      }
      if (active.size !== artifactIds.length) fail();
      const current = state();
      const artifacts = Object.fromEntries(
        Object.entries(current.artifacts).filter(([artifactId]) =>
          active.has(artifactId),
        ),
      );
      if (Object.keys(artifacts).length !== Object.keys(current.artifacts).length) {
        writeState({ ...current, artifacts });
      }
    },
    remove(record) {
      const parsed = outboxRecord(record);
      const entryName = record.entryName;
      if (typeof entryName !== "string" || !OUTBOX_NAME_RE.test(entryName)) fail();
      unlinkSync(join(directory, entryName));
      const current = state();
      writeState({
        ...current,
        errorCode:
          pending().length >= MAX_OUTBOX_ENTRIES ? current.errorCode : null,
      });
      return parsed;
    },
    quarantine(record) {
      const parsed = outboxRecord(record);
      const entryName = record.entryName;
      if (typeof entryName !== "string" || !OUTBOX_NAME_RE.test(entryName)) fail();
      const quarantined = {
        sequence: parsed.sequence,
        artifactId: parsed.artifactId,
        digest: parsed.digest,
        errorCode: "CONFIG_CONFLICT",
      };
      const current = state();
      const existing = current.quarantined.find(
        ({ sequence }) => sequence === parsed.sequence,
      );
      if (
        existing &&
        (existing.artifactId !== quarantined.artifactId ||
          existing.digest !== quarantined.digest ||
          existing.errorCode !== quarantined.errorCode)
      ) {
        fail();
      }
      const nextQuarantined = existing
        ? current.quarantined
        : [...current.quarantined, quarantined]
            .sort((left, right) => left.sequence - right.sequence)
            .slice(-MAX_QUARANTINE_ENTRIES);
      const retainedSequences = new Set(
        nextQuarantined.map(({ sequence }) => sequence),
      );
      for (const evicted of current.quarantined) {
        if (retainedSequences.has(evicted.sequence)) continue;
        const evictedName = `quarantine-${String(evicted.sequence).padStart(6, "0")}-${evicted.artifactId}-${evicted.digest}.json`;
        const evictedPath = join(directory, evictedName);
        if (existsSync(evictedPath)) unlinkSync(evictedPath);
      }
      // State is committed while the original fsync'd record is still pending.
      // A crash can therefore cause a safe retry, never loss of the raw evidence.
      writeState({
        ...current,
        quarantined: nextQuarantined,
        errorCode: "CONFIG_CONFLICT",
      });
      const quarantineName = entryName.replace(/^revision-/, "quarantine-");
      if (!QUARANTINE_NAME_RE.test(quarantineName)) fail();
      try {
        const quarantinePath = join(directory, quarantineName);
        if (existsSync(quarantinePath)) fail();
        renameSync(join(directory, entryName), quarantinePath);
        chmodSync(quarantinePath, 0o600);
        const directoryDescriptor = openSync(directory, constants.O_RDONLY);
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
      } catch {
        fail();
      }
      return parsed;
    },
    markError,
  };
}

export function artifactCheckpointHealth(directory) {
  if (!existsSync(directory)) return { pendingCount: 0, errorCode: null };
  const pendingCount = pendingRecords(directory).length;
  const state = readState(directory);
  return {
    pendingCount,
    errorCode:
      state.errorCode ?? (pendingCount > 0 ? "OUTBOX_PENDING" : null),
  };
}

export function checkpointConfiguredArtifacts({
  cwd,
  store,
  repositoryKey,
  checkpoint,
  runId,
  deadlineAt,
  now = Date.now,
} = {}) {
  let repository;
  if (
    !store ||
    typeof store.enqueue !== "function" ||
    typeof store.reconcileArtifacts !== "function"
  ) {
    fail();
  }
  try {
    repository = canonicalRepositoryKey(repositoryKey);
    if (!ARTIFACT_CHECKPOINTS.includes(checkpoint)) throw new Error();
  } catch {
    fail();
  }
  const artifacts = discoverConfiguredArtifacts({ cwd, deadlineAt, now });
  store.reconcileArtifacts(artifacts.map(({ artifactId }) => artifactId));
  let queued = 0;
  let overflow = false;
  for (const artifact of artifacts) {
    deadline(deadlineAt, now);
    const digest = createHash("sha256").update(artifact.markdown).digest("hex");
    if (store.state().artifacts[artifact.artifactId] === digest) continue;
    const result = store.enqueue({
      artifactId: artifact.artifactId,
      digest,
      body: {
        taskId: artifact.taskId,
        repositoryKey: repository,
        kind: artifact.kind,
        ...(runId === undefined ? {} : { runId }),
        checkpoint,
        markdown: artifact.markdown,
      },
    });
    if (result.status === "overflow") {
      overflow = true;
      break;
    }
    // The outbox write is fsync'd before the hash state can suppress discovery.
    store.markQueued(artifact.artifactId, digest);
    queued += 1;
  }
  const pending = store.pending().length;
  return {
    status: overflow ? "overflow" : queued > 0 ? "queued" : "unchanged",
    queued,
    pending,
  };
}

function localDeliveryBase(endpoint) {
  if (endpoint !== MANAGED_ENDPOINT) fail();
  return "http://127.0.0.1:43181";
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return "AUTH_REJECTED";
  return "TRANSPORT_UNAVAILABLE";
}

async function responseFailureCode(response) {
  if (response.status === 409) {
    try {
      const body = await response.json();
      if (
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        body.error === "CONFIG_CONFLICT"
      ) {
        return "CONFIG_CONFLICT";
      }
    } catch {
      // An ambiguous conflict remains retryable and its body stays private.
      try {
        await response.body?.cancel();
      } catch {
        // The bounded status code remains authoritative when body disposal fails.
      }
    }
    return "TRANSPORT_UNAVAILABLE";
  }
  try {
    await response.body?.cancel();
  } catch {
    // The bounded status code remains authoritative when body disposal fails.
  }
  return classifyStatus(response.status);
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    fail("TRANSPORT_UNAVAILABLE");
  }
}

function artifactRelayHeaders({ bindingNonce, bindingHeaders }) {
  if (bindingHeaders !== undefined) {
    const headers = exactObject(
      bindingHeaders,
      new Set(["X-Coredoc-Relay-Ingress", "X-Coredoc-Relay-Binding-Id"]),
    );
    if (
      bindingNonce !== undefined ||
      typeof headers["X-Coredoc-Relay-Ingress"] !== "string" ||
      !MANAGED_INGRESS_RE.test(headers["X-Coredoc-Relay-Ingress"]) ||
      typeof headers["X-Coredoc-Relay-Binding-Id"] !== "string" ||
      !BINDING_ID_RE.test(headers["X-Coredoc-Relay-Binding-Id"])
    ) {
      fail();
    }
    return { ...headers };
  }
  if (
    typeof bindingNonce !== "string" ||
    bindingNonce.length < 1 ||
    bindingNonce.length > 512 ||
    /[\s\0]/.test(bindingNonce)
  ) {
    fail();
  }
  return { "X-Coredoc-Relay-Binding": bindingNonce };
}

function configuredCodexBinding(value, expectedBindingId) {
  if (
    typeof value !== "string" ||
    typeof expectedBindingId !== "string" ||
    !BINDING_ID_RE.test(expectedBindingId)
  ) {
    fail();
  }
  const entries = value.split(",");
  if (entries.length !== 2) fail();
  const parsed = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) fail();
    const name = entry.slice(0, separator).trim().toLowerCase();
    const headerName =
      name === "x-coredoc-relay-ingress"
        ? "X-Coredoc-Relay-Ingress"
        : name === "x-coredoc-relay-binding-id"
          ? "X-Coredoc-Relay-Binding-Id"
          : null;
    if (headerName === null || Object.hasOwn(parsed, headerName)) fail();
    parsed[headerName] = entry.slice(separator + 1).trim();
  }
  const bindingId = expectedBindingId.toLowerCase();
  if (parsed["X-Coredoc-Relay-Binding-Id"]?.toLowerCase() !== bindingId) {
    fail();
  }
  const bindingHeaders = artifactRelayHeaders({ bindingHeaders: parsed });
  return {
    bindingHash: managedCaptureBindingStorageHash({
      bindingId,
      host: "codex",
    }),
    relayBinding: { bindingHeaders },
  };
}

function configuredRelayBinding(env) {
  if (env.COREDOC_CAPTURE_BINDING_ID !== undefined) {
    if (!BINDING_ID_RE.test(env.COREDOC_CAPTURE_BINDING_ID)) fail();
    try {
      const bindingNonce = relayBindingNonceFromCaptureHeaders(
        env.COREDOC_CAPTURE_HEADERS,
      );
      return {
        bindingHash: managedCaptureBindingStorageHash({
          bindingId: env.COREDOC_CAPTURE_BINDING_ID,
          bindingNonceHash: sha256BindingNonce(bindingNonce),
          host: "claude-code",
          workspaceMode: env.COREDOC_CAPTURE_WORKSPACE_MODE === "1",
        }),
        relayBinding: { bindingNonce },
      };
    } catch {
      // Codex uses the explicit ingress + binding-id header pair below.
    }
    return configuredCodexBinding(
      env.COREDOC_CAPTURE_HEADERS,
      env.COREDOC_CAPTURE_BINDING_ID,
    );
  }
  const bindingNonce = relayBindingNonceFromCaptureHeaders(
    env.COREDOC_CAPTURE_HEADERS,
  );
  return {
    bindingHash: managedCaptureBindingStorageHash({
      bindingNonceHash: sha256BindingNonce(bindingNonce),
      host: "claude-code",
    }),
    relayBinding: { bindingNonce },
  };
}

export async function flushArtifactCheckpoints({
  store,
  endpoint,
  bindingNonce,
  bindingHeaders,
  fetchImpl = fetch,
  timeoutMs = 4_500,
  now = Date.now,
} = {}) {
  if (!store || typeof store.pending !== "function") fail();
  const base = localDeliveryBase(endpoint);
  const relayHeaders = artifactRelayHeaders({ bindingNonce, bindingHeaders });
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  ) {
    fail();
  }
  const records = store.pending();
  const startedAt = now();
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  const budgetExpired = () =>
    deadlineSignal.aborted || now() - startedAt >= timeoutMs;
  const requestSignal = () => {
    if (budgetExpired()) fail("TRANSPORT_UNAVAILABLE");
    return AbortSignal.timeout(
      Math.max(1, timeoutMs - Math.max(0, now() - startedAt)),
    );
  };
  let attempted = 0;
  let sent = 0;
  let errorCode = records.length === 0 ? store.state().errorCode : null;
  for (const record of records) {
    if (budgetExpired()) {
      errorCode = "TRANSPORT_UNAVAILABLE";
      break;
    }
    attempted += 1;
    try {
      const taskBody = taskEnsureRequest({
        repositoryKey: record.body.repositoryKey,
      });
      const common = {
        method: "PUT",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          ...relayHeaders,
        },
      };
      const taskResponse = await fetchImpl(
        `${base}/delivery/v2/tasks/${record.body.taskId}`,
        {
          ...common,
          body: JSON.stringify(taskBody),
          signal: requestSignal(),
        },
      );
      if (!taskResponse.ok) {
        const code = await responseFailureCode(taskResponse);
        if (code !== "CONFIG_CONFLICT") fail(code);
        store.quarantine(record);
        errorCode = "CONFIG_CONFLICT";
        continue;
      }
      taskEnsureResponse(await responseJson(taskResponse), {
        taskId: record.body.taskId,
        repositoryKey: record.body.repositoryKey,
      });
      if (budgetExpired()) fail("TRANSPORT_UNAVAILABLE");

      const artifactResponse = await fetchImpl(
        `${base}/delivery/v2/artifacts/${record.artifactId}/revisions`,
        {
          ...common,
          body: JSON.stringify(record.body),
          signal: requestSignal(),
        },
      );
      if (!artifactResponse.ok) {
        const code = await responseFailureCode(artifactResponse);
        if (code !== "CONFIG_CONFLICT") fail(code);
        store.quarantine(record);
        errorCode = "CONFIG_CONFLICT";
        continue;
      }
      artifactRevisionResponse(await responseJson(artifactResponse), record);
      store.remove(record);
      sent += 1;
    } catch (error) {
      errorCode =
        error instanceof ArtifactCheckpointError &&
        HEALTH_ERROR_CODES.has(error.code)
          ? error.code
          : "TRANSPORT_UNAVAILABLE";
      store.markError(errorCode);
      break;
    }
  }
  if (records.length > 0 && (errorCode !== null || sent > 0)) {
    store.markError(errorCode);
  }
  return {
    attempted,
    sent,
    pending: store.pending().length,
    errorCode,
  };
}

function configuredContext(env, cwd) {
  if (env.COREDOC_CAPTURE_ENDPOINT !== MANAGED_ENDPOINT) return null;
  if (!existsSync(join(resolve(cwd), CONFIG_RELATIVE_PATH))) return null;
  let repositoryKey;
  if (env.COREDOC_CAPTURE_WORKSPACE_MODE === "1") {
    try {
      // This normalized origin is only a lookup candidate. The loopback relay
      // remains responsible for resolving it before cloud delivery.
      repositoryKey = canonicalRepositoryKey(
        requireRepositoryCandidate(resolveRepositoryIdentity(cwd)),
      );
    } catch (error) {
      if (error instanceof RepositoryUnavailableError) {
        fail("REPOSITORY_UNAVAILABLE");
      }
      throw error;
    }
  } else {
    if (!env.COREDOC_WORKFLOWS_REPO_KEY) return null;
    repositoryKey = canonicalRepositoryKey(env.COREDOC_WORKFLOWS_REPO_KEY);
  }
  const { bindingHash, relayBinding } = configuredRelayBinding(env);
  const relayRoot = join(resolve(stateRoot(env)), "capture-relay");
  return {
    endpoint: MANAGED_ENDPOINT,
    relayBinding,
    repositoryKey,
    store: createArtifactCheckpointStore({
      directory: artifactCheckpointDirectory(relayRoot, bindingHash),
    }),
  };
}

export async function runConfiguredArtifactCheckpoint({
  env = process.env,
  cwd = process.cwd(),
  checkpoint,
  runId,
  flush = true,
  fetchImpl = fetch,
  timeoutMs = 750,
  deadlineAt,
  now = Date.now,
} = {}) {
  let context;
  try {
    context = configuredContext(env, cwd);
    if (!context) {
      return { status: "disabled", queued: 0, sent: 0, pending: 0 };
    }
    const queued = checkpointConfiguredArtifacts({
      cwd,
      store: context.store,
      repositoryKey: context.repositoryKey,
      checkpoint,
      ...(runId === undefined ? {} : { runId }),
      deadlineAt,
      now,
    });
    if (!flush) return { ...queued, sent: 0 };
    const delivered = await flushArtifactCheckpoints({
      store: context.store,
      endpoint: context.endpoint,
      ...context.relayBinding,
      fetchImpl,
      timeoutMs,
    });
    return {
      status: delivered.pending === 0 ? "sent" : queued.status,
      queued: queued.queued,
      sent: delivered.sent,
      pending: delivered.pending,
      ...(delivered.errorCode === null
        ? {}
        : { errorCode: delivered.errorCode }),
    };
  } catch (error) {
    const code =
      error instanceof ArtifactCheckpointError ? error.code : "CONFIG_CONFLICT";
    if (context && HEALTH_ERROR_CODES.has(code)) {
      try {
        context.store.markError(code);
      } catch {
        // Corrupt state remains a bounded CONFIG_CONFLICT to the caller.
      }
    }
    return {
      status: code === "DEADLINE_EXCEEDED" ? "deadline" : "failed",
      queued: 0,
      sent: 0,
      pending: safePendingCount(context),
      ...(HEALTH_ERROR_CODES.has(code) ? { errorCode: code } : {}),
    };
  }
}

export async function retryReconcileConfiguredArtifacts({
  env = process.env,
  cwd = process.cwd(),
  fetchImpl = fetch,
  timeoutMs = 750,
} = {}) {
  let context;
  try {
    context = configuredContext(env, cwd);
    if (!context) {
      return { status: "disabled", attempted: 0, queued: 0, sent: 0, pending: 0 };
    }
    const retried = await flushArtifactCheckpoints({
      store: context.store,
      endpoint: context.endpoint,
      ...context.relayBinding,
      fetchImpl,
      timeoutMs,
    });
    const reconciled = checkpointConfiguredArtifacts({
      cwd,
      store: context.store,
      repositoryKey: context.repositoryKey,
      checkpoint: "session-start-reconcile",
    });
    const flushed = await flushArtifactCheckpoints({
      store: context.store,
      endpoint: context.endpoint,
      ...context.relayBinding,
      fetchImpl,
      timeoutMs,
    });
    return {
      status: flushed.pending === 0 ? "sent" : "pending",
      attempted: retried.attempted + flushed.attempted,
      queued: reconciled.queued,
      sent: retried.sent + flushed.sent,
      pending: flushed.pending,
      ...(flushed.errorCode === null ? {} : { errorCode: flushed.errorCode }),
    };
  } catch (error) {
    const code =
      error instanceof ArtifactCheckpointError
        ? error.code
        : "CONFIG_CONFLICT";
    if (context) {
      try {
        context.store.markError(
          HEALTH_ERROR_CODES.has(code) ? code : "CONFIG_CONFLICT",
        );
      } catch {
        // Corrupt state remains a bounded CONFIG_CONFLICT to the caller.
      }
    }
    return {
      status: "failed",
      attempted: 0,
      queued: 0,
      sent: 0,
      pending: safePendingCount(context),
      errorCode: HEALTH_ERROR_CODES.has(code) ? code : "CONFIG_CONFLICT",
    };
  }
}

function safePendingCount(context) {
  if (!context) return 0;
  try {
    return artifactCheckpointHealth(context.store.directory).pendingCount;
  } catch {
    return 0;
  }
}
