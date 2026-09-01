import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import {
  ArtifactCheckpointError,
  artifactCheckpointDirectory,
  artifactCheckpointHealth,
  checkpointConfiguredArtifacts,
  createArtifactCheckpointStore,
  discoverConfiguredArtifacts,
  flushArtifactCheckpoints,
  parseCoredocFrontmatter,
  retryReconcileConfiguredArtifacts,
  runConfiguredArtifactCheckpoint,
} from "./artifact-checkpoints.mjs";
import { renderClaudeGlobalSettings } from "./host-global-config.mjs";
import { sha256BindingNonce } from "./managed-otel-relay.mjs";

const TASK_ID = "cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTIFACT_ID = "cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "cdr-20260816-a1b2c3";
const REPOSITORY_KEY = "coredoc/coredoc-parser";
const BINDING_HASH = "a".repeat(64);

function digest(markdown) {
  return createHash("sha256").update(markdown).digest("hex");
}

function document(kind = "spec", body = "# Spec\n") {
  return `---\ncoredoc:\n  task_id: ${TASK_ID}\n  artifact_id: ${ARTIFACT_ID}\n  kind: ${kind}\n---\n${body}`;
}

function artifactId(index) {
  return `cda_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

function indexedDocument(index, body = `# Artifact ${index}\n`) {
  return document("spec", body).replace(ARTIFACT_ID, artifactId(index));
}

function conflictResponse() {
  return {
    ok: false,
    status: 409,
    json: async () => ({ error: "CONFIG_CONFLICT" }),
  };
}

function repositoryFixture({ glob = ".scratch/*/spec.md", kind = "spec" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "coredoc-artifact-repository-"));
  mkdirSync(join(root, ".coredoc"), { recursive: true });
  writeFileSync(
    join(root, ".coredoc", "delivery-observability.json"),
    `${JSON.stringify({ schemaVersion: 1, artifacts: [{ glob, kind }] })}\n`,
  );
  mkdirSync(join(root, ".scratch", "phase"), { recursive: true });
  writeFileSync(join(root, ".scratch", "phase", "spec.md"), document());
  return root;
}

function gitRepositoryWithOrigin(origin) {
  const root = repositoryFixture();
  execFileSync("git", ["init", "-q"], {
    cwd: root,
    stdio: ["ignore", "ignore", "ignore"],
  });
  execFileSync("git", ["remote", "add", "origin", origin], {
    cwd: root,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return root;
}

function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), "coredoc-artifact-state-"));
  const directory = artifactCheckpointDirectory(root, BINDING_HASH);
  return { root, directory, store: createArtifactCheckpointStore({ directory }) };
}

function expectCode(code) {
  return (error) => error instanceof ArtifactCheckpointError && error.code === code;
}

test("strict discovery reads only fixed config globs and exact coredoc frontmatter", () => {
  const root = repositoryFixture();
  assert.deepEqual(parseCoredocFrontmatter(document()), {
    taskId: TASK_ID,
    artifactId: ARTIFACT_ID,
    kind: "spec",
  });
  const [artifact] = discoverConfiguredArtifacts({ cwd: root });
  assert.equal(artifact.taskId, TASK_ID);
  assert.equal(artifact.artifactId, ARTIFACT_ID);
  assert.equal(artifact.kind, "spec");
  assert.equal(artifact.markdown, document());
  assert.equal(Object.hasOwn(artifact, "path"), false);

  for (const config of [
    { schemaVersion: 2, artifacts: [] },
    { schemaVersion: 1, artifacts: [], statusAuthority: "model" },
    { schemaVersion: 1, artifacts: [{ glob: "../private.md", kind: "spec" }] },
    { schemaVersion: 1, artifacts: [{ glob: ".scratch/*/spec.md", kind: "design" }] },
    { schemaVersion: 1, artifacts: Array.from({ length: 17 }, () => ({ glob: ".scratch/*/spec.md", kind: "spec" })) },
  ]) {
    writeFileSync(
      join(root, ".coredoc", "delivery-observability.json"),
      JSON.stringify(config),
    );
    assert.throws(() => discoverConfiguredArtifacts({ cwd: root }), expectCode("CONFIG_CONFLICT"));
  }

  assert.throws(
    () =>
      parseCoredocFrontmatter(
        document().replace("  kind: spec", "  kind: spec\n  statusAuthority: model"),
      ),
    expectCode("CONFIG_CONFLICT"),
  );
});

test("discovery refuses symlinks, hard links, invalid UTF-8, and oversized files", () => {
  for (const defect of ["symlink", "hardlink", "utf8", "oversize"]) {
    const root = repositoryFixture();
    const path = join(root, ".scratch", "phase", "spec.md");
    if (defect === "symlink") {
      const target = join(root, "private.md");
      writeFileSync(target, document());
      unlinkSync(path);
      symlinkSync(target, path);
    } else if (defect === "hardlink") {
      const target = join(root, "hardlink-source.md");
      writeFileSync(target, document());
      unlinkSync(path);
      linkSync(target, path);
    } else if (defect === "utf8") {
      writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
    } else if (defect === "oversize") {
      writeFileSync(path, Buffer.alloc(1_048_577, 0x61));
    }
    assert.throws(() => discoverConfiguredArtifacts({ cwd: root }), expectCode("CONFIG_CONFLICT"));
  }
});

test("configuration itself must be a bounded single-link regular file", () => {
  for (const defect of ["symlink", "hardlink", "oversize"]) {
    const root = repositoryFixture();
    const configPath = join(root, ".coredoc", "delivery-observability.json");
    const source = join(root, `config-${defect}.json`);
    writeFileSync(
      source,
      defect === "oversize"
        ? Buffer.alloc(64 * 1024 + 1, 0x20)
        : JSON.stringify({ schemaVersion: 1, artifacts: [] }),
    );
    unlinkSync(configPath);
    if (defect === "symlink") symlinkSync(source, configPath);
    else if (defect === "hardlink") linkSync(source, configPath);
    else writeFileSync(configPath, readFileSync(source));
    assert.throws(
      () => discoverConfiguredArtifacts({ cwd: root }),
      expectCode("CONFIG_CONFLICT"),
    );
  }
});

test("bounded discovery ignores unrelated entries and selects the newest sixteen matches", () => {
  const root = repositoryFixture();
  unlinkSync(join(root, ".scratch", "phase", "spec.md"));
  for (let index = 0; index < 40; index += 1) {
    mkdirSync(join(root, ".scratch", `unrelated-${String(index).padStart(2, "0")}`));
  }
  for (let index = 1; index <= 17; index += 1) {
    const directory = join(root, ".scratch", `phase-${String(index).padStart(2, "0")}`);
    const path = join(directory, "spec.md");
    mkdirSync(directory);
    writeFileSync(path, indexedDocument(index));
    utimesSync(path, index, index);
  }

  assert.deepEqual(
    discoverConfiguredArtifacts({ cwd: root }).map(({ artifactId: id }) => id),
    Array.from({ length: 16 }, (_, index) => artifactId(index + 2)).reverse(),
  );
});

test("discovery refuses duplicate artifact identities and obeys its injected deadline", () => {
  const root = repositoryFixture();
  writeFileSync(
    join(root, ".coredoc", "delivery-observability.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifacts: [
        { glob: ".scratch/*/spec.md", kind: "spec" },
        { glob: ".scratch/*/design.md", kind: "design" },
      ],
    }),
  );
  writeFileSync(
    join(root, ".scratch", "phase", "design.md"),
    document("design", "# Design\n"),
  );
  assert.throws(
    () => discoverConfiguredArtifacts({ cwd: root }),
    expectCode("CONFIG_CONFLICT"),
  );
  assert.throws(
    () =>
      discoverConfiguredArtifacts({
        cwd: root,
        deadlineAt: 100,
        now: () => 100,
      }),
    expectCode("DEADLINE_EXCEEDED"),
  );
});

test("durably queues before advancing hash state, deduplicates unchanged content, and refuses newest at cap 16", () => {
  const root = repositoryFixture();
  const { directory, store } = storeFixture();
  const first = checkpointConfiguredArtifacts({
    cwd: root,
    store,
    repositoryKey: REPOSITORY_KEY,
    checkpoint: "run-finish",
    runId: RUN_ID,
  });
  assert.deepEqual(first, { status: "queued", queued: 1, pending: 1 });
  const files = readdirSync(directory);
  assert.equal(files.filter((name) => name.endsWith(".json")).length, 2);
  for (const name of files) {
    assert.equal(lstatSync(join(directory, name)).mode & 0o777, 0o600);
  }
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  const persisted = files.map((name) => readFileSync(join(directory, name), "utf8")).join("\n");
  assert.doesNotMatch(persisted, /Bearer|binding|nonce|\.scratch|artifact-repository/);

  assert.deepEqual(
    checkpointConfiguredArtifacts({
      cwd: root,
      store,
      repositoryKey: REPOSITORY_KEY,
      checkpoint: "run-finish",
      runId: RUN_ID,
    }),
    { status: "unchanged", queued: 0, pending: 1 },
  );

  for (let index = 1; index < 16; index += 1) {
    const artifactId = `cda_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const markdown = `# ${index}`;
    assert.equal(
      store.enqueue({
        artifactId,
        digest: digest(markdown),
        body: {
          taskId: TASK_ID,
          repositoryKey: REPOSITORY_KEY,
          kind: "spec",
          checkpoint: "run-finish",
          markdown,
        },
      }).status,
      "queued",
    );
  }
  const refused = store.enqueue({
    artifactId: "cda_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    digest: digest("# newest"),
    body: {
      taskId: TASK_ID,
      repositoryKey: REPOSITORY_KEY,
      kind: "spec",
      checkpoint: "run-finish",
      markdown: "# newest",
    },
  });
  assert.deepEqual(refused, { status: "overflow", pending: 16 });
  assert.deepEqual(artifactCheckpointHealth(directory), {
    pendingCount: 16,
    errorCode: "OUTBOX_OVERFLOW",
  });
});

test("reconciles stale digest history before recording a new active artifact", () => {
  const root = repositoryFixture();
  const { store } = storeFixture();
  for (let index = 1; index <= 16; index += 1) {
    store.markQueued(artifactId(index), digest(`# historical ${index}`));
  }

  assert.deepEqual(
    checkpointConfiguredArtifacts({
      cwd: root,
      store,
      repositoryKey: REPOSITORY_KEY,
      checkpoint: "run-finish",
    }),
    { status: "queued", queued: 1, pending: 1 },
  );
  assert.deepEqual(store.state().artifacts, {
    [ARTIFACT_ID]: digest(document()),
  });
});

test("stable flush ensures the task before artifact PUT and removes only an exact digest receipt", async () => {
  const { directory, store } = storeFixture();
  const privateMarkdown = "# PRIVATE_ARTIFACT_CONTENT";
  store.enqueue({
    artifactId: ARTIFACT_ID,
    digest: digest(privateMarkdown),
    body: {
      taskId: TASK_ID,
      repositoryKey: REPOSITORY_KEY,
      kind: "spec",
      runId: RUN_ID,
      checkpoint: "run-finish",
      markdown: privateMarkdown,
    },
  });
  const calls = [];
  const result = await flushArtifactCheckpoints({
    store,
    endpoint: "http://127.0.0.1:43181/capture/v1/events",
    bindingNonce: "PRIVATE_LOCAL_NONCE",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith(`/tasks/${TASK_ID}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: TASK_ID,
            repositoryKey: REPOSITORY_KEY,
            lifecycle: "active",
            authority: "coredoc",
            externalRefs: [],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "accepted",
          artifact: { id: ARTIFACT_ID, taskId: TASK_ID, repositoryKey: REPOSITORY_KEY, kind: "spec" },
          revision: {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            sha256: digest(privateMarkdown),
            byteCount: Buffer.byteLength(privateMarkdown),
            checkpoint: "run-finish",
            runId: RUN_ID,
            createdAt: "2026-08-16T20:00:00.000Z",
          },
        }),
      };
    },
  });
  assert.deepEqual(result, { attempted: 1, sent: 1, pending: 0, errorCode: null });
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    `/delivery/v2/tasks/${TASK_ID}`,
    `/delivery/v2/artifacts/${ARTIFACT_ID}/revisions`,
  ]);
  for (const { init } of calls) {
    assert.deepEqual(init.headers, {
      "content-type": "application/json",
      "X-Coredoc-Relay-Binding": "PRIVATE_LOCAL_NONCE",
    });
    assert.equal(Object.hasOwn(init.headers, "Authorization"), false);
  }
  assert.notEqual(calls[0].init.signal, calls[1].init.signal);
  assert.deepEqual(store.pending(), []);

  store.enqueue({
    artifactId: ARTIFACT_ID,
    digest: digest("# changed"),
    body: {
      taskId: TASK_ID,
      repositoryKey: REPOSITORY_KEY,
      kind: "spec",
      checkpoint: "session-start-reconcile",
      markdown: "# changed",
    },
  });
  const invalid = await flushArtifactCheckpoints({
    store,
    endpoint: "http://127.0.0.1:43181/capture/v1/events",
    bindingNonce: "PRIVATE_LOCAL_NONCE",
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes("/tasks/")
          ? { id: TASK_ID, repositoryKey: REPOSITORY_KEY, lifecycle: "active", authority: "coredoc", externalRefs: [] }
          : {
              status: "duplicate",
              artifact: { id: ARTIFACT_ID, taskId: TASK_ID, repositoryKey: REPOSITORY_KEY, kind: "spec" },
              revision: {
                id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                sha256: "0".repeat(64),
                byteCount: 9,
                checkpoint: "run-finish",
                runId: null,
                createdAt: "2026-08-16T20:01:00.000Z",
              },
            },
    }),
  });
  assert.deepEqual(invalid, { attempted: 1, sent: 0, pending: 1, errorCode: "TRANSPORT_UNAVAILABLE" });
  assert.equal(store.pending().length, 1);
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE|changed|Bearer|path/);
});

test("V1, duplicate V1, then V2 produces exactly two durable artifact revisions", async () => {
  const root = repositoryFixture();
  const { store } = storeFixture();
  const artifactBodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes("/tasks/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: TASK_ID,
          repositoryKey: REPOSITORY_KEY,
          lifecycle: "active",
          authority: "coredoc",
          externalRefs: [],
        }),
      };
    }
    artifactBodies.push(body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "accepted",
        artifact: {
          id: ARTIFACT_ID,
          taskId: TASK_ID,
          repositoryKey: REPOSITORY_KEY,
          kind: "spec",
        },
        revision: {
          id:
            artifactBodies.length === 1
              ? "11111111-1111-4111-8111-111111111111"
              : "22222222-2222-4222-8222-222222222222",
          sha256: digest(body.markdown),
          byteCount: Buffer.byteLength(body.markdown),
          checkpoint: body.checkpoint,
          runId: body.runId ?? null,
          createdAt: "2026-08-16T20:00:00.000Z",
        },
      }),
    };
  };
  const checkpointAndFlush = async (checkpoint) => {
    checkpointConfiguredArtifacts({
      cwd: root,
      store,
      repositoryKey: REPOSITORY_KEY,
      checkpoint,
      runId: RUN_ID,
    });
    await flushArtifactCheckpoints({
      store,
      endpoint: "http://127.0.0.1:43181/capture/v1/events",
      bindingNonce: "local-binding",
      fetchImpl,
    });
  };

  await checkpointAndFlush("run-finish");
  await checkpointAndFlush("run-finish");
  writeFileSync(
    join(root, ".scratch", "phase", "spec.md"),
    document("spec", "# V2\n"),
  );
  await checkpointAndFlush("session-start-reconcile");

  assert.equal(artifactBodies.length, 2);
  assert.deepEqual(
    artifactBodies.map(({ checkpoint, markdown }) => ({ checkpoint, markdown })),
    [
      { checkpoint: "run-finish", markdown: document() },
      {
        checkpoint: "session-start-reconcile",
        markdown: document("spec", "# V2\n"),
      },
    ],
  );
});

test("durably quarantines an artifact 409 and continues with later checkpoints", async () => {
  const { directory, store } = storeFixture();
  const conflictedMarkdown = "# PRIVATE_CONFLICTED_ARTIFACT";
  const nextArtifactId = "cda_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const nextMarkdown = "# deliverable";
  for (const [artifactId, markdown] of [
    [ARTIFACT_ID, conflictedMarkdown],
    [nextArtifactId, nextMarkdown],
  ]) {
    store.enqueue({
      artifactId,
      digest: digest(markdown),
      body: {
        taskId: TASK_ID,
        repositoryKey: REPOSITORY_KEY,
        kind: "spec",
        checkpoint: "run-finish",
        markdown,
      },
    });
  }

  const calls = [];
  const result = await flushArtifactCheckpoints({
    store,
    endpoint: "http://127.0.0.1:43181/capture/v1/events",
    bindingNonce: "PRIVATE_LOCAL_NONCE",
    fetchImpl: async (url, init) => {
      calls.push(new URL(url).pathname);
      if (url.includes("/tasks/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: TASK_ID,
            repositoryKey: REPOSITORY_KEY,
            lifecycle: "active",
            authority: "coredoc",
            externalRefs: [],
          }),
        };
      }
      if (url.includes(`/artifacts/${ARTIFACT_ID}/`)) {
        return conflictResponse();
      }
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "accepted",
          artifact: {
            id: nextArtifactId,
            taskId: TASK_ID,
            repositoryKey: REPOSITORY_KEY,
            kind: "spec",
          },
          revision: {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            sha256: digest(body.markdown),
            byteCount: Buffer.byteLength(body.markdown),
            checkpoint: "run-finish",
            runId: null,
            createdAt: "2026-08-16T20:01:00.000Z",
          },
        }),
      };
    },
  });

  assert.deepEqual(result, {
    attempted: 2,
    sent: 1,
    pending: 0,
    errorCode: "CONFIG_CONFLICT",
  });
  assert.deepEqual(calls, [
    `/delivery/v2/tasks/${TASK_ID}`,
    `/delivery/v2/artifacts/${ARTIFACT_ID}/revisions`,
    `/delivery/v2/tasks/${TASK_ID}`,
    `/delivery/v2/artifacts/${nextArtifactId}/revisions`,
  ]);
  assert.deepEqual(store.pending(), []);
  assert.deepEqual(store.state().quarantined, [
    {
      sequence: 1,
      artifactId: ARTIFACT_ID,
      digest: digest(conflictedMarkdown),
      errorCode: "CONFIG_CONFLICT",
    },
  ]);
  assert.deepEqual(artifactCheckpointHealth(directory), {
    pendingCount: 0,
    errorCode: "CONFIG_CONFLICT",
  });
  assert.deepEqual(
    createArtifactCheckpointStore({ directory }).state().quarantined,
    store.state().quarantined,
  );
  const persistedState = readFileSync(join(directory, "state.json"), "utf8");
  assert.doesNotMatch(
    persistedState,
    /PRIVATE|Users|conflicted-spec|deliverable|coredoc\/coredoc-parser|cdt_/,
  );
  const quarantineFiles = readdirSync(directory).filter((name) =>
    name.startsWith("quarantine-"),
  );
  assert.equal(quarantineFiles.length, 1);
  assert.equal(lstatSync(join(directory, quarantineFiles[0])).mode & 0o777, 0o600);
  assert.match(
    readFileSync(join(directory, quarantineFiles[0]), "utf8"),
    /PRIVATE_CONFLICTED_ARTIFACT/,
  );

  assert.deepEqual(
    await flushArtifactCheckpoints({
      store,
      endpoint: "http://127.0.0.1:43181/capture/v1/events",
      bindingNonce: "PRIVATE_LOCAL_NONCE",
      fetchImpl: async () => {
        throw new Error("empty drain must not fetch");
      },
    }),
    {
      attempted: 0,
      sent: 0,
      pending: 0,
      errorCode: "CONFIG_CONFLICT",
    },
  );
  assert.deepEqual(artifactCheckpointHealth(directory), {
    pendingCount: 0,
    errorCode: "CONFIG_CONFLICT",
  });
  assert.equal(store.state().quarantined.length, 1);

  const correctedArtifactId = "cda_dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const correctedMarkdown = "# corrected identity";
  store.enqueue({
    artifactId: correctedArtifactId,
    digest: digest(correctedMarkdown),
    body: {
      taskId: TASK_ID,
      repositoryKey: REPOSITORY_KEY,
      kind: "spec",
      checkpoint: "session-start-reconcile",
      markdown: correctedMarkdown,
    },
  });
  assert.deepEqual(
    await flushArtifactCheckpoints({
      store,
      endpoint: "http://127.0.0.1:43181/capture/v1/events",
      bindingNonce: "PRIVATE_LOCAL_NONCE",
      fetchImpl: async (url, init) => {
        if (url.includes("/tasks/")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: TASK_ID,
              repositoryKey: REPOSITORY_KEY,
              lifecycle: "active",
              authority: "coredoc",
              externalRefs: [],
            }),
          };
        }
        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "accepted",
            artifact: {
              id: correctedArtifactId,
              taskId: TASK_ID,
              repositoryKey: REPOSITORY_KEY,
              kind: "spec",
            },
            revision: {
              id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              sha256: digest(body.markdown),
              byteCount: Buffer.byteLength(body.markdown),
              checkpoint: "session-start-reconcile",
              runId: null,
              createdAt: "2026-08-16T20:04:00.000Z",
            },
          }),
        };
      },
    }),
    { attempted: 1, sent: 1, pending: 0, errorCode: null },
  );
  assert.deepEqual(artifactCheckpointHealth(directory), {
    pendingCount: 0,
    errorCode: null,
  });
  assert.equal(store.state().quarantined.length, 1);
});

test("quarantines a task-ensure 409 without blocking a later artifact", async () => {
  const { store } = storeFixture();
  const conflictedMarkdown = "# conflicted task";
  const nextTaskId = "cdt_dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const nextArtifactId = "cda_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const nextMarkdown = "# later artifact";
  for (const [taskId, artifactId, markdown] of [
    [TASK_ID, ARTIFACT_ID, conflictedMarkdown],
    [nextTaskId, nextArtifactId, nextMarkdown],
  ]) {
    store.enqueue({
      artifactId,
      digest: digest(markdown),
      body: {
        taskId,
        repositoryKey: REPOSITORY_KEY,
        kind: "spec",
        checkpoint: "run-finish",
        markdown,
      },
    });
  }

  const calls = [];
  const result = await flushArtifactCheckpoints({
    store,
    endpoint: "http://127.0.0.1:43181/capture/v1/events",
    bindingNonce: "PRIVATE_LOCAL_NONCE",
    fetchImpl: async (url, init) => {
      calls.push(new URL(url).pathname);
      if (url.endsWith(`/tasks/${TASK_ID}`)) {
        return conflictResponse();
      }
      if (url.includes("/tasks/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: nextTaskId,
            repositoryKey: REPOSITORY_KEY,
            lifecycle: "active",
            authority: "coredoc",
            externalRefs: [],
          }),
        };
      }
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "accepted",
          artifact: {
            id: nextArtifactId,
            taskId: nextTaskId,
            repositoryKey: REPOSITORY_KEY,
            kind: "spec",
          },
          revision: {
            id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            sha256: digest(body.markdown),
            byteCount: Buffer.byteLength(body.markdown),
            checkpoint: "run-finish",
            runId: null,
            createdAt: "2026-08-16T20:02:00.000Z",
          },
        }),
      };
    },
  });

  assert.deepEqual(result, {
    attempted: 2,
    sent: 1,
    pending: 0,
    errorCode: "CONFIG_CONFLICT",
  });
  assert.deepEqual(calls, [
    `/delivery/v2/tasks/${TASK_ID}`,
    `/delivery/v2/tasks/${nextTaskId}`,
    `/delivery/v2/artifacts/${nextArtifactId}/revisions`,
  ]);
  assert.deepEqual(store.state().quarantined, [
    {
      sequence: 1,
      artifactId: ARTIFACT_ID,
      digest: digest(conflictedMarkdown),
      errorCode: "CONFIG_CONFLICT",
    },
  ]);
});

test("rotates saturated quarantine evidence before continuing past a seventeenth 409", async () => {
  const { directory, store } = storeFixture();
  const artifactId = (index) =>
    `cda_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const enqueue = (index) => {
    const markdown = `# conflict ${index}`;
    store.enqueue({
      artifactId: artifactId(index),
      digest: digest(markdown),
      body: {
        taskId: TASK_ID,
        repositoryKey: REPOSITORY_KEY,
        kind: "spec",
        checkpoint: "run-finish",
        markdown,
      },
    });
  };

  for (let index = 1; index <= 16; index += 1) enqueue(index);
  assert.deepEqual(
    await flushArtifactCheckpoints({
      store,
      endpoint: "http://127.0.0.1:43181/capture/v1/events",
      bindingNonce: "PRIVATE_LOCAL_NONCE",
      fetchImpl: async () => conflictResponse(),
    }),
    {
      attempted: 16,
      sent: 0,
      pending: 0,
      errorCode: "CONFIG_CONFLICT",
    },
  );

  enqueue(17);
  enqueue(18);
  let call = 0;
  const result = await flushArtifactCheckpoints({
    store,
    endpoint: "http://127.0.0.1:43181/capture/v1/events",
    bindingNonce: "PRIVATE_LOCAL_NONCE",
    fetchImpl: async (url, init) => {
      call += 1;
      if (call === 1) return conflictResponse();
      if (url.includes("/tasks/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: TASK_ID,
            repositoryKey: REPOSITORY_KEY,
            lifecycle: "active",
            authority: "coredoc",
            externalRefs: [],
          }),
        };
      }
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "accepted",
          artifact: {
            id: artifactId(18),
            taskId: TASK_ID,
            repositoryKey: REPOSITORY_KEY,
            kind: "spec",
          },
          revision: {
            id: "11111111-2222-4333-8444-555555555555",
            sha256: digest(body.markdown),
            byteCount: Buffer.byteLength(body.markdown),
            checkpoint: "run-finish",
            runId: null,
            createdAt: "2026-08-16T20:03:00.000Z",
          },
        }),
      };
    },
  });

  assert.deepEqual(result, {
    attempted: 2,
    sent: 1,
    pending: 0,
    errorCode: "CONFIG_CONFLICT",
  });
  assert.deepEqual(
    store.state().quarantined.map(({ sequence }) => sequence),
    Array.from({ length: 16 }, (_, index) => index + 2),
  );
  assert.deepEqual(
    createArtifactCheckpointStore({ directory }).state().quarantined.at(-1),
    {
      sequence: 17,
      artifactId: artifactId(17),
      digest: digest("# conflict 17"),
      errorCode: "CONFIG_CONFLICT",
    },
  );
  assert.deepEqual(store.pending(), []);
  const quarantineFiles = readdirSync(directory).filter((name) =>
    name.startsWith("quarantine-"),
  );
  assert.equal(quarantineFiles.length, 16);
  assert.ok(
    quarantineFiles.every(
      (name) => (lstatSync(join(directory, name)).mode & 0o777) === 0o600,
    ),
  );
});

test("keeps an ambiguous 409 pending instead of treating it as a terminal identity conflict", async () => {
  const { store } = storeFixture();
  const markdown = "# retry ambiguous conflict";
  store.enqueue({
    artifactId: ARTIFACT_ID,
    digest: digest(markdown),
    body: {
      taskId: TASK_ID,
      repositoryKey: REPOSITORY_KEY,
      kind: "spec",
      checkpoint: "run-finish",
      markdown,
    },
  });

  assert.deepEqual(
    await flushArtifactCheckpoints({
      store,
      endpoint: "http://127.0.0.1:43181/capture/v1/events",
      bindingNonce: "PRIVATE_LOCAL_NONCE",
      fetchImpl: async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "TEMPORARY_CONFLICT" }),
      }),
    }),
    {
      attempted: 1,
      sent: 0,
      pending: 1,
      errorCode: "TRANSPORT_UNAVAILABLE",
    },
  );
  assert.equal(store.state().quarantined.length, 0);
  assert.equal(store.pending().length, 1);
});

test("stops a conflict drain before starting another request after its budget expires", async () => {
  const { store } = storeFixture();
  for (let index = 1; index <= 2; index += 1) {
    const markdown = `# deadline conflict ${index}`;
    store.enqueue({
      artifactId: artifactId(index),
      digest: digest(markdown),
      body: {
        taskId: TASK_ID,
        repositoryKey: REPOSITORY_KEY,
        kind: "spec",
        checkpoint: "run-finish",
        markdown,
      },
    });
  }
  let calls = 0;
  let clock = 0;
  const result = await flushArtifactCheckpoints({
    store,
    endpoint: "http://127.0.0.1:43181/capture/v1/events",
    bindingNonce: "PRIVATE_LOCAL_NONCE",
    timeoutMs: 1000,
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      // Simulate elapsed wall-clock time during the network call so the
      // budget is exhausted by the time the response comes back, without
      // depending on real timers.
      clock += 2000;
      return conflictResponse();
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    attempted: 1,
    sent: 0,
    pending: 1,
    errorCode: "TRANSPORT_UNAVAILABLE",
  });
});

test("does not start an artifact request after task validation exhausts the drain budget", async () => {
  const { store } = storeFixture();
  const markdown = "# slow task ensure";
  store.enqueue({
    artifactId: ARTIFACT_ID,
    digest: digest(markdown),
    body: {
      taskId: TASK_ID,
      repositoryKey: REPOSITORY_KEY,
      kind: "spec",
      checkpoint: "run-finish",
      markdown,
    },
  });
  const calls = [];
  let clock = 0;
  const result = await flushArtifactCheckpoints({
    store,
    endpoint: "http://127.0.0.1:43181/capture/v1/events",
    bindingNonce: "PRIVATE_LOCAL_NONCE",
    timeoutMs: 1000,
    now: () => clock,
    fetchImpl: async (url) => {
      calls.push(new URL(url).pathname);
      // Simulate elapsed wall-clock time during the task-ensure call so the
      // budget is exhausted before the artifact request would start, without
      // depending on real timers.
      clock += 2000;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: TASK_ID,
          repositoryKey: REPOSITORY_KEY,
          lifecycle: "active",
          authority: "coredoc",
          externalRefs: [],
        }),
      };
    },
  });

  assert.deepEqual(calls, [`/delivery/v2/tasks/${TASK_ID}`]);
  assert.deepEqual(result, {
    attempted: 1,
    sent: 0,
    pending: 1,
    errorCode: "TRANSPORT_UNAVAILABLE",
  });
});

test("artifact flush retains evidence and exposes only closed auth/config/transport codes", async () => {
  for (const [status, errorCode] of [
    [403, "AUTH_REJECTED"],
    [500, "TRANSPORT_UNAVAILABLE"],
  ]) {
    const { store } = storeFixture();
    const markdown = "# PRIVATE_EVIDENCE";
    store.enqueue({
      artifactId: ARTIFACT_ID,
      digest: digest(markdown),
      body: {
        taskId: TASK_ID,
        repositoryKey: REPOSITORY_KEY,
        kind: "spec",
        checkpoint: "run-finish",
        markdown,
      },
    });
    const result = await flushArtifactCheckpoints({
      store,
      endpoint: "http://127.0.0.1:43181/capture/v1/events",
      bindingNonce: "PRIVATE_LOCAL_NONCE",
      fetchImpl: async () => ({
        ok: false,
        status,
        json: async () => ({
          message: "PRIVATE_RAW_BODY /Users/alice/spec.md",
        }),
      }),
    });
    assert.deepEqual(result, {
      attempted: 1,
      sent: 0,
      pending: 1,
      errorCode,
    });
    assert.equal(store.pending().length, 1);
    assert.doesNotMatch(
      JSON.stringify(result),
      /PRIVATE|Users|spec\.md|Bearer|nonce/,
    );
  }
});

test("unconfigured managed artifacts are disabled without scanning stale state or fetching", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "coredoc-artifact-disabled-"));
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-artifact-disabled-state-"));
  const env = {
    COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:43181/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: "X-Coredoc-Relay-Binding=local-binding",
    COREDOC_WORKFLOWS_REPO_KEY: REPOSITORY_KEY,
    COREDOC_WORKFLOWS_STATE_HOME: stateHome,
  };
  const fetchImpl = async () => {
    throw new Error("fetch must not run");
  };
  assert.deepEqual(
    await runConfiguredArtifactCheckpoint({
      env,
      cwd,
      checkpoint: "run-finish",
      fetchImpl,
    }),
    { status: "disabled", queued: 0, sent: 0, pending: 0 },
  );
  assert.deepEqual(
    await retryReconcileConfiguredArtifacts({ env, cwd, fetchImpl }),
    { status: "disabled", attempted: 0, queued: 0, sent: 0, pending: 0 },
  );
});

test("workspace artifacts fail explicitly when no normalized repository candidate exists", async () => {
  const cwd = repositoryFixture();
  let calls = 0;
  const env = {
    COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:43181/capture/v1/events",
    COREDOC_CAPTURE_HEADERS:
      "X-Coredoc-Relay-Ingress=machine_ingress_abcdefghijklmnopqrstuvwxyz012345,X-Coredoc-Relay-Binding-Id=22222222-2222-4222-8222-222222222222",
    COREDOC_CAPTURE_BINDING_ID: "22222222-2222-4222-8222-222222222222",
    COREDOC_CAPTURE_WORKSPACE_MODE: "1",
    COREDOC_WORKFLOWS_STATE_HOME: mkdtempSync(
      join(tmpdir(), "coredoc-artifact-repoless-state-"),
    ),
  };
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("repository-less artifacts must not reach the relay");
  };
  const result = await runConfiguredArtifactCheckpoint({
    env,
    cwd,
    checkpoint: "run-finish",
    fetchImpl,
  });

  assert.deepEqual(result, {
    status: "failed",
    queued: 0,
    sent: 0,
    pending: 0,
    errorCode: "REPOSITORY_UNAVAILABLE",
  });
  assert.deepEqual(
    await retryReconcileConfiguredArtifacts({ env, cwd, fetchImpl }),
    {
      status: "failed",
      attempted: 0,
      queued: 0,
      sent: 0,
      pending: 0,
      errorCode: "REPOSITORY_UNAVAILABLE",
    },
  );
  assert.equal(calls, 0);
});

test("workspace artifact requests carry only a normalized candidate and loopback capability", async () => {
  const cwd = gitRepositoryWithOrigin(
    "https://github.com/acme/workspace-payments.git",
  );
  const stateHome = mkdtempSync(
    join(tmpdir(), "coredoc-artifact-workspace-state-"),
  );
  const ingress = "machine_ingress_abcdefghijklmnopqrstuvwxyz012345";
  const bindingId = "22222222-2222-4222-8222-222222222222";
  const calls = [];
  const result = await runConfiguredArtifactCheckpoint({
    env: {
      COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:43181/capture/v1/events",
      COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Ingress=${ingress},X-Coredoc-Relay-Binding-Id=${bindingId}`,
      COREDOC_CAPTURE_BINDING_ID: bindingId,
      COREDOC_CAPTURE_WORKSPACE_MODE: "1",
      COREDOC_CAPTURE_REPOSITORY_CANDIDATE_KEY: "stale/injected",
      COREDOC_WORKFLOWS_REPO_KEY: "stale/legacy",
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    cwd,
    checkpoint: "run-finish",
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, headers: init.headers, body });
      if (url.endsWith(`/tasks/${TASK_ID}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: TASK_ID,
            repositoryKey: "acme/workspace-payments",
            lifecycle: "active",
            authority: "coredoc",
            externalRefs: [],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "accepted",
          artifact: {
            id: ARTIFACT_ID,
            taskId: TASK_ID,
            repositoryKey: "acme/workspace-payments",
            kind: "spec",
          },
          revision: {
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            sha256: digest(body.markdown),
            byteCount: Buffer.byteLength(body.markdown),
            checkpoint: body.checkpoint,
            runId: body.runId ?? null,
            createdAt: "2026-08-16T20:00:00.000Z",
          },
        }),
      };
    },
  });

  assert.deepEqual(result, {
    status: "sent",
    queued: 1,
    sent: 1,
    pending: 0,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, {
    repositoryKey: "acme/workspace-payments",
  });
  assert.equal(calls[1].body.repositoryKey, "acme/workspace-payments");
  for (const call of calls) {
    assert.match(call.url, /^http:\/\/127\.0\.0\.1:43181\//);
    assert.deepEqual(call.headers, {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": ingress,
      "X-Coredoc-Relay-Binding-Id": bindingId,
    });
    assert.equal(Object.hasOwn(call.headers, "Authorization"), false);
  }
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /github\.com|origin|stale\/injected|stale\/legacy/);
  assert.doesNotMatch(serialized, new RegExp(cwd));
});

test("rendered workspace Claude env authenticates with its nonce and stores artifacts by binding ID", async () => {
  const cwd = gitRepositoryWithOrigin(
    "https://github.com/acme/workspace-payments.git",
  );
  const stateHome = mkdtempSync(
    join(tmpdir(), "coredoc-artifact-claude-workspace-state-"),
  );
  const ingress = "claude_ingress_abcdefghijklmnopqrstuvwxyz012345";
  const bindingId = "22222222-2222-4222-8222-222222222222";
  const rendered = JSON.parse(
    renderClaudeGlobalSettings("{}", {
      operation: "install",
      ingressToken: ingress,
      bindingId,
      workspaceId: "33333333-3333-4333-8333-333333333333",
    }),
  ).env;

  const result = await runConfiguredArtifactCheckpoint({
    env: {
      ...rendered,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    cwd,
    checkpoint: "run-finish",
    flush: false,
  });

  assert.deepEqual(result, {
    status: "queued",
    queued: 1,
    pending: 1,
    sent: 0,
  });
  const directory = artifactCheckpointDirectory(
    join(stateHome, "capture-relay"),
    sha256BindingNonce(bindingId),
  );
  assert.equal(artifactCheckpointHealth(directory).pendingCount, 1);
});

test("configured Codex artifacts use ingress and binding-ID authentication", async () => {
  const cwd = repositoryFixture();
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-artifact-codex-state-"));
  const ingress = "machine_ingress_abcdefghijklmnopqrstuvwxyz012345";
  const bindingId = "22222222-2222-4222-8222-222222222222";
  const calls = [];
  const result = await runConfiguredArtifactCheckpoint({
    env: {
      COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:43181/capture/v1/events",
      COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Ingress=${ingress},X-Coredoc-Relay-Binding-Id=${bindingId}`,
      COREDOC_CAPTURE_BINDING_ID: bindingId,
      COREDOC_WORKFLOWS_REPO_KEY: REPOSITORY_KEY,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    cwd,
    checkpoint: "run-finish",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith(`/tasks/${TASK_ID}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: TASK_ID,
            repositoryKey: REPOSITORY_KEY,
            lifecycle: "active",
            authority: "coredoc",
            externalRefs: [],
          }),
        };
      }
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "accepted",
          artifact: {
            id: ARTIFACT_ID,
            taskId: TASK_ID,
            repositoryKey: REPOSITORY_KEY,
            kind: "spec",
          },
          revision: {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            sha256: digest(body.markdown),
            byteCount: Buffer.byteLength(body.markdown),
            checkpoint: body.checkpoint,
            runId: body.runId ?? null,
            createdAt: "2026-08-16T20:00:00.000Z",
          },
        }),
      };
    },
  });

  assert.deepEqual(result, {
    status: "sent",
    queued: 1,
    sent: 1,
    pending: 0,
  });
  for (const { init } of calls) {
    assert.deepEqual(init.headers, {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": ingress,
      "X-Coredoc-Relay-Binding-Id": bindingId,
    });
  }
  const state = JSON.parse(
    readFileSync(
      join(
        artifactCheckpointDirectory(
          join(stateHome, "capture-relay"),
          digest(bindingId),
        ),
        "state.json",
      ),
      "utf8",
    ),
  );
  assert.equal(state.schemaVersion, 1);
});

test("corrupt managed state returns one bounded CONFIG_CONFLICT instead of rethrowing diagnostics", async () => {
  const cwd = repositoryFixture();
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-artifact-corrupt-state-"));
  const nonce = "local-binding";
  const directory = artifactCheckpointDirectory(
    join(stateHome, "capture-relay"),
    digest(nonce),
  );
  createArtifactCheckpointStore({ directory });
  writeFileSync(join(directory, "state.json"), '{"schemaVersion":999}\n', {
    mode: 0o600,
  });
  const result = await runConfiguredArtifactCheckpoint({
    env: {
      COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:43181/capture/v1/events",
      COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Binding=${nonce}`,
      COREDOC_WORKFLOWS_REPO_KEY: REPOSITORY_KEY,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    cwd,
    checkpoint: "run-finish",
    fetchImpl: async () => {
      throw new Error("fetch must not run");
    },
  });
  assert.deepEqual(result, {
    status: "failed",
    queued: 0,
    sent: 0,
    pending: 0,
    errorCode: "CONFIG_CONFLICT",
  });
  assert.doesNotMatch(JSON.stringify(result), /state|path|Bearer|local-binding/);
});

test("artifact diagnostics refuse non-0700 directories and non-0600 state", () => {
  const { directory, store } = storeFixture();
  store.markError("AUTH_REJECTED");
  chmodSync(directory, 0o755);
  assert.throws(
    () => artifactCheckpointHealth(directory),
    expectCode("CONFIG_CONFLICT"),
  );
  chmodSync(directory, 0o700);
  chmodSync(join(directory, "state.json"), 0o644);
  assert.throws(
    () => artifactCheckpointHealth(directory),
    expectCode("CONFIG_CONFLICT"),
  );
});
