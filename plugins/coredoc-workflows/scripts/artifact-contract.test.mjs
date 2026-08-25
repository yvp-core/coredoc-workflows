import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "../test/test-api.mjs";

import {
  artifactRevisionRequest,
  artifactRevisionResponse,
  deliveryRoute,
  taskEnsureRequest,
  taskEnsureResponse,
} from "../runtime/artifacts/contract.mjs";

const TASK_ID = "cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTIFACT_ID = "cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPOSITORY_KEY = "acme/api";

test("accepts the exact task/artifact write contracts including empty Markdown", () => {
  assert.deepEqual(taskEnsureRequest({ repositoryKey: REPOSITORY_KEY }), {
    repositoryKey: REPOSITORY_KEY,
  });
  assert.deepEqual(
    artifactRevisionRequest({
      taskId: TASK_ID,
      repositoryKey: REPOSITORY_KEY,
      kind: "spec",
      checkpoint: "run-finish",
      markdown: "",
    }),
    {
      taskId: TASK_ID,
      repositoryKey: REPOSITORY_KEY,
      kind: "spec",
      checkpoint: "run-finish",
      markdown: "",
    },
  );
  assert.deepEqual(deliveryRoute(`/delivery/v2/tasks/${TASK_ID}`), {
    kind: "task",
    taskId: TASK_ID,
  });
  assert.deepEqual(
    deliveryRoute(`/delivery/v2/artifacts/${ARTIFACT_ID}/revisions`),
    { kind: "artifact", artifactId: ARTIFACT_ID },
  );
});

test("rejects unknown fields, invalid Unicode/control content, nullable run IDs, and oversized UTF-8", () => {
  const valid = {
    taskId: TASK_ID,
    repositoryKey: REPOSITORY_KEY,
    kind: "spec",
    checkpoint: "run-finish",
    markdown: "# safe",
  };
  for (const body of [
    { ...valid, path: ".scratch/private.md" },
    { ...valid, runId: null },
    { ...valid, markdown: "safe\0unsafe" },
    { ...valid, markdown: "safe\u0085unsafe" },
    { ...valid, markdown: "safe\ud800unsafe" },
    { ...valid, markdown: "é".repeat(1_048_576 / 2) + "a" },
  ]) {
    assert.throws(() => artifactRevisionRequest(body));
  }
});

test("acknowledges only exact task identity and exact accepted/duplicate digest receipts", () => {
  assert.deepEqual(
    taskEnsureResponse(
      {
        id: TASK_ID,
        repositoryKey: REPOSITORY_KEY,
        lifecycle: "active",
        authority: "coredoc",
        externalRefs: [],
      },
      { taskId: TASK_ID, repositoryKey: REPOSITORY_KEY },
    ).id,
    TASK_ID,
  );
  const body = {
    taskId: TASK_ID,
    repositoryKey: REPOSITORY_KEY,
    kind: "spec",
    checkpoint: "run-finish",
    markdown: "# revision",
  };
  const digest = createHash("sha256").update(body.markdown).digest("hex");
  const receipt = {
    status: "duplicate",
    artifact: {
      id: ARTIFACT_ID,
      taskId: TASK_ID,
      repositoryKey: REPOSITORY_KEY,
      kind: "spec",
    },
    revision: {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      sha256: digest,
      byteCount: Buffer.byteLength(body.markdown),
      checkpoint: "run-finish",
      runId: null,
      createdAt: "2026-08-16T20:00:00.000Z",
    },
  };
  assert.equal(
    artifactRevisionResponse(receipt, { artifactId: ARTIFACT_ID, body, digest })
      .status,
    "duplicate",
  );
  for (const invalid of [
    { ...receipt, rawBody: "PRIVATE" },
    {
      ...receipt,
      revision: { ...receipt.revision, id: "opaque-revision" },
    },
    {
      ...receipt,
      revision: { ...receipt.revision, sha256: "0".repeat(64) },
    },
  ]) {
    assert.throws(() =>
      artifactRevisionResponse(invalid, {
        artifactId: ARTIFACT_ID,
        body,
        digest,
      }),
    );
  }
});
