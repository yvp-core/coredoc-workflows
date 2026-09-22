import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";
import { checkInvestigation, saveInvestigation } from "./investigation.mjs";
import { executeRoutedTask } from "./route-task.mjs";
import { finishWorkflowStage, readWorkflowRun, startWorkflowRun, startWorkflowStage } from "./workflow-run-state.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "investigation-reuse-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, "repo"); mkdirSync(cwd);
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  writeFileSync(join(cwd, "logic.txt"), "first\n"); git("add", "."); git("commit", "-m", "base");
  const report = join(directory, "report.md"); writeFileSync(report, "Observed failure, reproduction and confirmed cause.\n");
  const env = { COREDOC_WORKFLOWS_STATE_DIR: join(directory, "state"), COREDOC_WORKFLOWS_SESSION_ID: "source-session" };
  startWorkflowRun({ sessionId: "source-session", runId: "cdr-20260922-aaaaaa", workflowId: "diagnose:normal", intent: "diagnose", risk: "normal", declaredStages: [{ stageId: "investigate", after: [] }], cwd }, { env });
  startWorkflowStage("source-session", "investigate", {}, { env });
  const options = { cwd, env };
  const input = { key: "refund-race", scope: ["refund handler", "billing proxy"], report };
  const save = () => { finishWorkflowStage("source-session", "investigate", "success", {}, { env }); return saveInvestigation(input, options); };
  return { cwd, env, report, git, options, input, save };
}

test("reuses a completed investigation and keeps its provenance local without inventing an occurrence", async (t) => {
  const f = fixture(t);
  assert.throws(() => saveInvestigation(f.input, f.options), /successfully completed/);
  const saved = f.save();
  assert.equal(statSync(saved.record).mode & 0o777, 0o600);
  const env = { ...f.env, COREDOC_WORKFLOWS_SESSION_ID: "target-session" };
  const signals = { intent: "change", bugLike: true, reuseInvestigation: saved.record, investigationKey: f.input.key, investigationScope: [...f.input.scope].reverse() };
  let captured;
  const result = await executeRoutedTask(signals, { cwd: f.cwd, env, preflight: async () => {}, expireRuns: async () => [], recordCapture: async (routed) => { captured = routed; return { status: "disabled" }; } });
  assert.deepEqual(result.stages.map(({ id }) => id), ["implement"]);
  assert.equal(result.investigationReuse.sourceRunId, "cdr-20260922-aaaaaa");
  const state = readWorkflowRun("target-session", { env });
  assert.equal(state.stageProgress.investigate, undefined);
  assert.equal(state.investigationReuse.report, f.report);
  assert.equal(JSON.stringify(captured).includes(f.report), false);
  assert.equal(JSON.stringify(captured).includes(f.input.key), false);
  assert.equal(readFileSync(saved.record, "utf8").includes("Observed failure"), false);
});

test("refuses task, scope, report, tracked edits and commit changes", (t) => {
  const f = fixture(t); const saved = f.save();
  const input = { ...f.input, record: saved.record };
  assert.throws(() => checkInvestigation({ ...input, key: "different-task" }, f.options), /task or scope/);
  assert.throws(() => checkInvestigation({ ...input, scope: ["new scope"] }, f.options), /task or scope/);
  writeFileSync(f.report, "changed report");
  assert.throws(() => checkInvestigation(input, f.options), /report changed/);
  writeFileSync(f.report, "Observed failure, reproduction and confirmed cause.\n");
  writeFileSync(join(f.cwd, "logic.txt"), "second\n");
  assert.throws(() => checkInvestigation(input, f.options), /revision changed/);
  f.git("add", "."); f.git("commit", "-m", "changed");
  assert.throws(() => checkInvestigation(input, f.options), /revision changed/);
});

test("invalidates an already-untracked file edited in place and refuses missing evidence", (t) => {
  const f = fixture(t);
  const untracked = join(f.cwd, "new.txt"); writeFileSync(untracked, "before");
  const saved = f.save(); const input = { ...f.input, record: saved.record };
  checkInvestigation(input, f.options);
  writeFileSync(untracked, "after!");
  assert.throws(() => checkInvestigation(input, f.options), /revision changed/);
  writeFileSync(untracked, "before"); rmSync(f.report);
  assert.throws(() => checkInvestigation(input, f.options), /ENOENT/);
});

test("invalid evidence refuses routing before capture or state mutation", async (t) => {
  const f = fixture(t); const saved = f.save();
  let starts = 0;
  await assert.rejects(() => executeRoutedTask({ intent: "change", bugLike: true, reuseInvestigation: saved.record, investigationKey: "wrong", investigationScope: f.input.scope }, { ...f.options, startRun: () => { starts++; }, preflight: async () => {} }), /task or scope/);
  assert.equal(starts, 0);
});


test("refuses dirty submodules even when repository settings hide them", (t) => {
  const f = fixture(t);
  const source = join(f.cwd, "..", "module-source"); mkdirSync(source);
  const git = (...args) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
  git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  writeFileSync(join(source, "module.txt"), "base"); git("add", "."); git("commit", "-m", "base");
  f.git("-c", "protocol.file.allow=always", "submodule", "add", source, "child"); f.git("commit", "-am", "submodule");
  f.git("config", "submodule.child.ignore", "all");
  const saved = f.save(); const input = { ...f.input, record: saved.record };
  writeFileSync(join(f.cwd, "child", "module.txt"), "dirty one");
  assert.throws(() => checkInvestigation(input, f.options), /Dirty submodule/);
  assert.throws(() => saveInvestigation(f.input, f.options), /Dirty submodule/);
  writeFileSync(join(f.cwd, "child", "module.txt"), "dirty two");
  assert.throws(() => checkInvestigation(input, f.options), /Dirty submodule/);
  const commitChild = (content) => {
    writeFileSync(join(f.cwd, "child", "module.txt"), content);
    f.git("-C", "child", "add", ".");
    f.git("-C", "child", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", content);
  };
  commitChild("second");
  const advanced = f.save();
  commitChild("third");
  assert.throws(() => checkInvestigation({ ...input, record: advanced.record }, f.options), /revision changed/);

});
