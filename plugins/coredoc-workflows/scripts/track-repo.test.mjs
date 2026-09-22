import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";
import { finishWorkflowRun } from "./finish-run.mjs";
import { parseTrackRepoArgs } from "./track-repo.mjs";
import { completeWorkflowRun, readWorkflowRun, registerWorkflowRepository, startWorkflowRun, suspendWorkflowRun } from "./workflow-run-state.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-multi-repo-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { COREDOC_WORKFLOWS_STATE_DIR: join(root, "state") };
  function repo(name) {
    const cwd = join(root, name);
    mkdirSync(cwd);
    const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    writeFileSync(join(cwd, "file.txt"), "before\n");
    git("add", "file.txt");
    git("commit", "-m", "fixture");
    return cwd;
  }
  const first = repo("first");
  const second = repo("second");
  startWorkflowRun({ sessionId: "multi-repo", runId: "cdr-20260922-aabbcc", workflowId: "change:normal", intent: "change", risk: "normal", cwd: first }, { env });
  return { env, first, second };
}

test("a run started in A measures an edit in registered B without exporting paths", (t) => {
  const { env, first, second } = fixture(t);
  assert.equal(registerWorkflowRepository("multi-repo", second, { env }).status, "tracked");
  const baseline = readWorkflowRun("multi-repo", { env }).repositories[0];
  writeFileSync(join(second, "file.txt"), "after\nnew line\n");
  mkdirSync(join(second, "sub"));
  assert.equal(registerWorkflowRepository("multi-repo", join(second, "sub"), { env }).status, "already-tracked");
  assert.equal(registerWorkflowRepository("multi-repo", first, { env }).status, "already-tracked");
  assert.deepEqual(readWorkflowRun("multi-repo", { env }).repositories, [baseline]);
  const { summary } = completeWorkflowRun("multi-repo", { env });
  assert.equal(summary.changed, true);
  assert.equal(summary.headChanged, false);
  assert.equal(summary.filesChangedAtFinish, 1);
  assert.equal(summary.trackedLinesAddedAtFinish, 2);
  assert.equal(summary.trackedLinesRemovedAtFinish, 1);
  assert.ok(!JSON.stringify(summary).includes(first));
  assert.ok(!JSON.stringify(summary).includes(second));
});

test("missing registered repository cannot silently become a zero measurement", (t) => {
  const { env, second } = fixture(t);
  registerWorkflowRepository("multi-repo", second, { env });
  rmSync(second, { recursive: true, force: true });
  assert.throws(() => completeWorkflowRun("multi-repo", { env }), /Tracked repository is unavailable/);
});

test("registration refuses inactive sessions, nonrepositories and malformed CLI arguments", (t) => {
  const { env } = fixture(t);
  assert.throws(() => registerWorkflowRepository("missing", tmpdir(), { env }), /No active workflow run/);
  assert.throws(() => registerWorkflowRepository("multi-repo", tmpdir(), { env }), /accessible Git checkout/);
  assert.equal(parseTrackRepoArgs(["--path", "/local/path with spaces"]), "/local/path with spaces");
  for (const args of [[], ["--path"], ["--path", "--oops"], ["--path", "/repo", "extra"]]) {
    assert.throws(() => parseTrackRepoArgs(args), /usage:/);
  }
});

for (const outcome of ["failed", "blocked", "abandoned"]) {
  test(`a missing secondary checkout can close as ${outcome} without leaking paths`, async (t) => {
    const { env, first, second } = fixture(t);
    registerWorkflowRepository("multi-repo", second, { env });
    rmSync(second, { recursive: true, force: true });
    let captured;
    const dependencies = {
      env, cwd: first,
      checkpointArtifacts: async () => ({ status: "disabled", pending: 0 }),
      deliver: async (event) => {
        captured = event;
        return { status: "disabled", durable: true, pending: 0 };
      },
    };
    await assert.rejects(
      finishWorkflowRun({ sessionId: "multi-repo", outcome: "success" }, dependencies),
      /Tracked repository is unavailable/,
    );
    assert.equal(readWorkflowRun("multi-repo", { env }).status, "active");
    const result = await finishWorkflowRun({ sessionId: "multi-repo", outcome }, dependencies);
    assert.equal(result.status, "finished");
    assert.deepEqual(result.repositoryMeasurement, {
      status: "incomplete", unavailableRepositories: [second],
    });
    assert.equal(readWorkflowRun("multi-repo", { env }), null);
    for (const payload of [captured, result.event]) {
      assert.ok(!JSON.stringify(payload).includes(first));
      assert.ok(!JSON.stringify(payload).includes(second));
    }
    assert.equal(startWorkflowRun({ sessionId: "multi-repo", runId: "cdr-20260922-ddeeff", workflowId: "change:normal", intent: "change", risk: "normal", cwd: first }, { env }).status, "started");
  });
}

test("suspended measurements retain each checkout and ignore changes made after suspension", (t) => {
  const { env, first, second } = fixture(t);
  registerWorkflowRepository("multi-repo", second, { env });
  writeFileSync(join(second, "file.txt"), "changed before suspension\nsecond line\n");
  suspendWorkflowRun("multi-repo", {}, { env });
  // Replacing B with A's clean snapshot would lose B's edit and its line count.
  writeFileSync(join(first, "file.txt"), "changed after suspension\n");
  rmSync(second, { recursive: true, force: true });
  const { summary, repositoryMeasurement } = completeWorkflowRun("multi-repo", { env, useSuspendedSnapshots: true });
  assert.equal(repositoryMeasurement, undefined);
  assert.equal(summary.changed, true);
  assert.equal(summary.filesChangedAtFinish, 1);
  assert.equal(summary.trackedLinesAddedAtFinish, 2);
  assert.equal(summary.trackedLinesRemovedAtFinish, 1);
});

test("two unchanged suspended repositories remain unchanged", (t) => {
  const { env, second } = fixture(t);
  registerWorkflowRepository("multi-repo", second, { env });
  suspendWorkflowRun("multi-repo", {}, { env });
  const { summary } = completeWorkflowRun("multi-repo", { env, useSuspendedSnapshots: true });
  assert.equal(summary.changed, false);
  assert.equal(summary.filesChangedAtFinish, 0);
});
