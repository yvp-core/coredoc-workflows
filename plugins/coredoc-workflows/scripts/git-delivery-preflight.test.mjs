import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import test from "../test/test-api.mjs";
import {
  preflightDelivery,
  verifyCreatedCommit,
} from "./git-delivery-preflight.mjs";

const exec = promisify(execFile);
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LAUNCHER = join(PLUGIN_ROOT, "bin", "coredoc-workflows");

async function git(cwd, ...args) {
  return exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

async function fixture(t, { trunk = "main", generated = false } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "coredoc-delivery-"));
  const remote = join(scratch, "remote.git");
  const repo = join(scratch, "repo");
  t.after(() => rm(scratch, { recursive: true, force: true }));

  await mkdir(repo);
  await git(scratch, "init", "--bare", `--initial-branch=${trunk}`, remote);
  await git(repo, "init", `--initial-branch=${trunk}`);
  await git(repo, "config", "user.name", "Delivery Test");
  await git(repo, "config", "user.email", "delivery@example.com");
  await writeFile(join(repo, "README.md"), "baseline\n");
  if (generated) {
    await writeFile(join(repo, ".gitattributes"), "generated.js linguist-generated=true\n");
  }
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "baseline");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", trunk);
  await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${trunk}`);
  return { repo, remote, scratch, trunk };
}

function credential() {
  return `ghp_${"A7".repeat(18)}`;
}

function commitPreflight(cwd, message = "safe test commit") {
  const exactMessage = message.endsWith("\n") ? message : `${message}\n`;
  return preflightDelivery({ cwd, operation: "commit", message: exactMessage });
}

test("commit preflight scans only staged additions and never returns secret text", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/staged-secret");

  const secret = credential();
  await writeFile(join(repo, "config.txt"), `TOKEN=${secret}\n`);
  await git(repo, "add", "config.txt");

  const blocked = await commitPreflight(repo);
  assert.equal(blocked.verdict, "blocked");
  assert.equal(blocked.reason, "secret-detected");
  assert.equal(blocked.scan.scope, "staged-and-message");
  assert.deepEqual(
    blocked.scan.findings.map(({ id, path, line, tier }) => ({ id, path, line, tier })),
    [{ id: "github.pat", path: "config.txt", line: 1, tier: "HIGH" }],
  );
  assert.doesNotMatch(JSON.stringify(blocked), new RegExp(secret));

  await git(repo, "commit", "-m", "temporary secret fixture");
  await writeFile(join(repo, "config.txt"), "TOKEN_FROM_ENV=true\n");
  await git(repo, "add", "config.txt");

  const removal = await commitPreflight(repo);
  assert.equal(removal.verdict, "ready");
  assert.deepEqual(removal.scan.findings, []);
});

test("push preflight scans every outbound commit, including an added-then-removed secret", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/history-secret");

  const secret = credential();
  await writeFile(join(repo, "transient.txt"), `${secret}\n`);
  await git(repo, "add", "transient.txt");
  await git(repo, "commit", "-m", "add transient value");
  await rm(join(repo, "transient.txt"));
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "remove transient value");

  const result = await preflightDelivery({ cwd: repo, operation: "push" });
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "secret-detected");
  assert.equal(result.scan.scope, "outbound-commits");
  assert.equal(result.scan.commitCount, 2);
  assert.equal(result.scan.findings[0].path, "transient.txt");
  assert.match(result.scan.findings[0].commit, /^[0-9a-f]{40,64}$/);
  assert.equal(result.push.source, result.repo.head);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("push preflight blocks a secret in outbound commit metadata without echoing it", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/metadata-secret");

  const secret = credential();
  await writeFile(join(repo, "safe.txt"), "safe content\n");
  await git(repo, "add", "safe.txt");
  await git(repo, "commit", "-m", `accidental credential ${secret}`);

  const result = await preflightDelivery({ cwd: repo, operation: "push" });
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "secret-detected");
  assert.deepEqual(
    result.scan.findings.map(({ id, tier, scope, source, commit }) => ({
      id,
      tier,
      scope,
      source,
      commit,
    })),
    [{
      id: "github.pat",
      tier: "HIGH",
      scope: "commit-metadata",
      source: "builtin",
      commit: result.repo.head,
    }],
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("commit preflight requires and scans the exact proposed message", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/message-secret");
  await writeFile(join(repo, "safe.txt"), "safe content\n");
  await git(repo, "add", "safe.txt");

  const missing = await preflightDelivery({ cwd: repo, operation: "commit" });
  assert.equal(missing.verdict, "blocked");
  assert.equal(missing.reason, "commit-message-required");

  const ambiguousBytes = await preflightDelivery({
    cwd: repo,
    operation: "commit",
    message: "safe but missing the final newline",
  });
  assert.equal(ambiguousBytes.verdict, "blocked");
  assert.equal(ambiguousBytes.reason, "commit-message-final-newline-required");

  const secret = credential();
  const blocked = await commitPreflight(repo, `accidental credential ${secret}`);
  assert.equal(blocked.verdict, "blocked");
  assert.equal(blocked.reason, "secret-detected");
  assert.deepEqual(
    blocked.scan.findings.map(({ id, tier, scope, source }) => ({ id, tier, scope, source })),
    [{
      id: "github.pat",
      tier: "HIGH",
      scope: "commit-message",
      source: "builtin",
    }],
  );
  assert.doesNotMatch(JSON.stringify(blocked), new RegExp(secret));
});

test("post-commit verification catches a hook that replaces the scanned index", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/hook-drift");
  await writeFile(join(repo, "safe.txt"), "safe content\n");
  await git(repo, "add", "safe.txt");

  const before = await commitPreflight(repo, "safe feature");
  assert.equal(before.verdict, "ready");
  assert.match(before.commit.indexFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.match(before.commit.messageFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(before.commit.expectedParent, before.repo.head);

  const secret = credential();
  const hook = join(repo, ".git", "hooks", "pre-commit");
  await writeFile(
    hook,
    `#!/bin/sh\nprintf '%s\\n' '${secret}' > hook-added.txt\ngit add hook-added.txt\n`,
  );
  await chmod(hook, 0o755);
  await git(repo, "commit", "-m", "safe feature");
  const created = (await git(repo, "rev-parse", "HEAD")).stdout.trim();

  const verification = await verifyCreatedCommit({
    cwd: repo,
    commit: created,
    expectedParent: before.commit.expectedParent,
    expectedIndexFingerprint: before.commit.indexFingerprint,
    expectedMessageFingerprint: before.commit.messageFingerprint,
  });
  assert.equal(verification.verdict, "blocked");
  assert.equal(verification.reason, "secret-detected");
  assert.equal(verification.commit.treeMatchesExpected, false);
  assert.equal(verification.scan.findings[0].path, "hook-added.txt");
  assert.doesNotMatch(JSON.stringify(verification), new RegExp(secret));
});

test("post-commit verification accepts the exact scanned tree and message", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/verified-commit");
  await writeFile(join(repo, "safe.txt"), "safe content\n");
  await git(repo, "add", "safe.txt");

  const before = await commitPreflight(repo, "safe feature");
  assert.equal(before.verdict, "ready");
  await git(repo, "commit", "-m", "safe feature");
  const created = (await git(repo, "rev-parse", "HEAD")).stdout.trim();

  const verification = await verifyCreatedCommit({
    cwd: repo,
    commit: created,
    expectedParent: before.commit.expectedParent,
    expectedIndexFingerprint: before.commit.indexFingerprint,
    expectedMessageFingerprint: before.commit.messageFingerprint,
  });
  assert.equal(verification.verdict, "ready");
  assert.equal(verification.reason, null);
  assert.equal(verification.commit.treeMatchesExpected, true);
  assert.equal(verification.commit.messageMatchesExpected, true);
  assert.equal(verification.commit.parent, before.repo.head);
  assert.deepEqual(verification.scan.findings, []);

  const { stdout } = await exec(
    LAUNCHER,
    [
      "git-delivery-preflight",
      "--verify-created",
      created,
      "--expected-branch",
      "feat/verified-commit",
      "--expected-parent",
      before.commit.expectedParent,
      "--expected-index",
      before.commit.indexFingerprint,
      "--expected-message",
      before.commit.messageFingerprint,
    ],
    { cwd: repo },
  );
  assert.equal(JSON.parse(stdout).verdict, "ready");
});

test("post-commit verification rejects a scanner-clean message changed by a hook", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/message-hook-drift");
  await writeFile(join(repo, "safe.txt"), "safe content\n");
  await git(repo, "add", "safe.txt");

  const intendedMessage = join(repo, ".git", "INTENDED_COMMIT_MESSAGE");
  await writeFile(intendedMessage, "intended safe message\n");
  const before = await preflightDelivery({
    cwd: repo,
    operation: "commit",
    messageFile: intendedMessage,
  });
  assert.equal(before.verdict, "ready");

  const hook = join(repo, ".git", "hooks", "commit-msg");
  await writeFile(hook, "#!/bin/sh\nprintf 'different safe message\\n' > \"$1\"\n");
  await chmod(hook, 0o755);
  await git(repo, "commit", "--cleanup=verbatim", "--file", intendedMessage);
  const created = (await git(repo, "rev-parse", "HEAD")).stdout.trim();

  const verification = await verifyCreatedCommit({
    cwd: repo,
    commit: created,
    expectedParent: before.commit.expectedParent,
    expectedIndexFingerprint: before.commit.indexFingerprint,
    expectedMessageFingerprint: before.commit.messageFingerprint,
  });
  assert.equal(verification.verdict, "blocked");
  assert.equal(verification.reason, "commit-message-drift");
  assert.equal(verification.commit.treeMatchesExpected, true);
  assert.equal(verification.commit.messageMatchesExpected, false);
  assert.deepEqual(verification.scan.findings, []);
});

test("diff header parsing does not skip an added line whose content resembles a file header", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/plus-prefix");
  const secret = credential();
  await writeFile(join(repo, "prefix.txt"), `++ ${secret}\n`);
  await git(repo, "add", "prefix.txt");

  const result = await commitPreflight(repo);
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "secret-detected");
  assert.equal(result.scan.findings[0].path, "prefix.txt");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("commit preflight requires review for a staged binary file", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/binary");
  await writeFile(join(repo, "artifact.bin"), Buffer.from([0, 1, 2, 3, 255, 0, 4]));
  await git(repo, "add", "artifact.bin");

  const result = await commitPreflight(repo);
  assert.equal(result.verdict, "needs-action");
  assert.equal(result.reason, "binary-review-required");
  assert.deepEqual(result.scan.binaryPaths, ["artifact.bin"]);
});

test("secret-shaped Git metadata is blocked and redacted from output", async (t) => {
  const { repo } = await fixture(t);
  const secret = credential();
  await git(repo, "switch", "-c", `feat/${secret}`);
  await writeFile(join(repo, "safe.txt"), "safe\n");
  await git(repo, "add", "safe.txt");

  const result = await commitPreflight(repo);
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "secret-bearing-git-metadata");
  assert.equal(result.repo.branch, "<redacted>");
  assert.equal(result.metadataRedacted, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("secret-shaped paths are blocked and redacted from binary inventory", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/secret-path");
  const secret = credential();
  const name = `artifact-${secret}.bin`;
  await writeFile(join(repo, name), Buffer.from([0, 1, 2, 0, 255]));
  await git(repo, "add", name);

  const result = await commitPreflight(repo);
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "secret-bearing-git-metadata");
  assert.deepEqual(result.scan.binaryPaths, ["<redacted>"]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("push preflight scans the endpoint Git will use when origin has a pushUrl", async (t) => {
  const { repo, remote, scratch } = await fixture(t);
  const pushRemote = join(scratch, "push.git");
  await git(scratch, "clone", "--bare", remote, pushRemote);

  await git(repo, "switch", "-c", "feat/push-url");
  const secret = credential();
  await writeFile(join(repo, "published-to-fetch-origin.txt"), `${secret}\n`);
  await git(repo, "add", "published-to-fetch-origin.txt");
  await git(repo, "commit", "-m", "commit visible only at the fetch URL");
  await git(repo, "push", "origin", "HEAD:refs/heads/feat/push-url");
  await writeFile(join(repo, "safe.txt"), "safe follow-up\n");
  await git(repo, "add", "safe.txt");
  await git(repo, "commit", "-m", "safe local follow-up");
  await git(repo, "config", "remote.origin.pushurl", pushRemote);

  const result = await preflightDelivery({ cwd: repo, operation: "push" });
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "secret-detected");
  assert.equal(result.repo.publication.relation, "unpublished");
  assert.equal(result.scan.commitCount, 2);
  assert.equal(result.push.configureUpstream, true);
  assert.equal("setUpstream" in result.push, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("push preflight fails closed when origin has multiple push destinations", async (t) => {
  const { repo, remote, scratch } = await fixture(t);
  const secondRemote = join(scratch, "second-push.git");
  await git(scratch, "clone", "--bare", remote, secondRemote);
  await git(repo, "switch", "-c", "feat/multiple-push-urls");
  await writeFile(join(repo, "safe.txt"), "safe\n");
  await git(repo, "add", "safe.txt");
  await git(repo, "commit", "-m", "safe feature");
  await git(repo, "config", "--add", "remote.origin.pushurl", remote);
  await git(repo, "config", "--add", "remote.origin.pushurl", secondRemote);

  const result = await preflightDelivery({ cwd: repo, operation: "push" });
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "multiple-push-destinations");
  assert.equal(result.push, null);
});

test("the exact push suppresses ambient tags and configures tracking only after publication", async (t) => {
  const { repo, remote } = await fixture(t);
  const branch = "feat/exact-publication";
  await git(repo, "switch", "-c", branch);
  await writeFile(join(repo, "safe.txt"), "safe\n");
  await git(repo, "add", "safe.txt");
  await git(repo, "commit", "-m", "safe feature");
  await git(repo, "tag", "-a", "unexpected-tag", "-m", "must remain local");
  await git(repo, "config", "push.followTags", "true");
  await git(repo, "config", "remote.origin.mirror", "true");

  const result = await preflightDelivery({ cwd: repo, operation: "push" });
  assert.equal(result.verdict, "ready");
  assert.equal(result.push.configureUpstream, true);
  await git(
    repo,
    "-c",
    "remote.origin.mirror=false",
    "push",
    "--no-follow-tags",
    "--recurse-submodules=no",
    result.push.remote,
    `${result.push.source}:${result.push.destination}`,
  );
  const tags = await git(repo, "ls-remote", "--tags", remote);
  assert.equal(tags.stdout.trim(), "");

  await git(repo, "branch", `--set-upstream-to=origin/${branch}`, branch);
  const upstream = await git(repo, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`);
  assert.equal(upstream.stdout.trim(), `origin/${branch}`);
});

test("push preflight scans stored commits without honoring local replacement refs", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/replaced-object");
  const secret = credential();
  await writeFile(join(repo, "replaced.txt"), `${secret}\n`);
  await git(repo, "add", "replaced.txt");
  await git(repo, "commit", "-m", "secret-bearing stored commit");
  const original = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  const parent = (await git(repo, "rev-parse", "HEAD^")).stdout.trim();
  const cleanTree = (await git(repo, "rev-parse", `${parent}^{tree}`)).stdout.trim();
  const replacement = (
    await git(repo, "commit-tree", cleanTree, "-p", parent, "-m", "clean replacement")
  ).stdout.trim();
  await git(repo, "replace", original, replacement);

  const result = await preflightDelivery({ cwd: repo, operation: "push" });
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "secret-detected");
  assert.equal(result.push.source, original);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("commit preflight distinguishes an unstaged file from a staged diff", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/unstaged");
  await writeFile(join(repo, "unstaged.txt"), "not selected for commit\n");

  const result = await commitPreflight(repo);
  assert.equal(result.verdict, "needs-action");
  assert.equal(result.reason, "nothing-staged");
  assert.deepEqual(result.changes.worktree, {
    stagedPresent: false,
    unstagedPresent: false,
    untrackedPresent: true,
    unmergedPresent: false,
  });
});

test("commit preflight blocks an index with unresolved merge entries", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "conflict-source");
  await writeFile(join(repo, "README.md"), "source side\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "source-side change");

  await git(repo, "switch", "main");
  await git(repo, "switch", "-c", "feat/conflicted-index");
  await writeFile(join(repo, "README.md"), "feature side\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "feature-side change");
  await assert.rejects(git(repo, "merge", "conflict-source", "--no-edit"));

  const result = await commitPreflight(repo);
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "unmerged-index");
  assert.equal(result.changes.worktree.unmergedPresent, true);
});

test("unchanged nearby context can qualify a secret on an added line", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/context-secret");
  const prefix = `aws_secret_access_key =\n${"\n".repeat(11)}`;
  await writeFile(join(repo, "aws.conf"), `${prefix}not-set\n`);
  await git(repo, "add", "aws.conf");
  await git(repo, "commit", "-m", "add credential setting shape");

  const secret = `${"aB3/".repeat(9)}aB3x`;
  await writeFile(join(repo, "aws.conf"), `${prefix}${secret}\n`);
  await git(repo, "add", "aws.conf");

  const result = await commitPreflight(repo);
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "secret-detected");
  assert.equal(result.scan.findings[0].id, "aws.secret_key");
  assert.equal(result.scan.findings[0].line, 13);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret.replaceAll("/", "\\/")));
});

test("PR preflight distinguishes publication state and preserves total/generated metrics", async (t) => {
  const { repo, remote, scratch } = await fixture(t, { generated: true });
  await git(repo, "switch", "-c", "feat/pr-state");
  await writeFile(join(repo, "source.js"), "export const answer = 42;\n");
  await writeFile(join(repo, "generated.js"), "compiled output\n");
  await git(repo, "add", "source.js", "generated.js");
  await git(repo, "commit", "-m", "add source and generated output");

  const unpublished = await preflightDelivery({ cwd: repo, operation: "pr" });
  assert.equal(unpublished.verdict, "needs-action");
  assert.equal(unpublished.reason, "branch-not-published");

  await git(repo, "push", "-u", "origin", "HEAD:refs/heads/feat/pr-state");
  const ready = await preflightDelivery({ cwd: repo, operation: "pr" });
  assert.equal(ready.verdict, "ready");
  assert.equal(ready.repo.publication.relation, "equal");
  assert.deepEqual(ready.changes.total, { files: 2, lines: 2, binaryFiles: 0 });
  assert.deepEqual(ready.changes.reviewable, { files: 1, lines: 1, binaryFiles: 0 });
  assert.deepEqual(ready.changes.generatedFiles, [
    { path: "generated.js", source: "gitattributes" },
  ]);

  const infoAttributes = join(repo, ".git", "info", "attributes");
  await writeFile(infoAttributes, "generated.js -linguist-generated\n");
  const localAttributes = await preflightDelivery({ cwd: repo, operation: "pr" });
  assert.equal(localAttributes.verdict, "blocked");
  assert.equal(localAttributes.reason, "pr-local-attributes-present");
  await rm(infoAttributes);

  const globalAttributes = join(scratch, "global-attributes");
  await writeFile(globalAttributes, "generated.js -linguist-generated\n");
  await git(repo, "config", "core.attributesFile", globalAttributes);
  const isolatedAttributes = await preflightDelivery({ cwd: repo, operation: "pr" });
  assert.equal(isolatedAttributes.verdict, "ready");
  assert.deepEqual(isolatedAttributes.changes.generatedFiles, [
    { path: "generated.js", source: "gitattributes" },
  ]);
  await git(repo, "config", "--unset", "core.attributesFile");

  await writeFile(join(repo, ".gitattributes"), "");
  const dirtyAttributes = await preflightDelivery({ cwd: repo, operation: "pr" });
  assert.equal(dirtyAttributes.verdict, "ready");
  assert.deepEqual(dirtyAttributes.changes.generatedFiles, [
    { path: "generated.js", source: "gitattributes" },
  ]);

  await git(repo, "add", ".gitattributes");
  const stagedAttributes = await preflightDelivery({ cwd: repo, operation: "pr" });
  assert.equal(stagedAttributes.verdict, "blocked");
  assert.equal(stagedAttributes.reason, "pr-attributes-not-at-head");
  await git(repo, "restore", "--staged", ".gitattributes");
  await git(repo, "restore", ".gitattributes");

  await writeFile(join(repo, "source.js"), "export const answer = 43;\n");
  await git(repo, "add", "source.js");
  await git(repo, "commit", "-m", "advance local branch");
  const ahead = await preflightDelivery({ cwd: repo, operation: "pr" });
  assert.equal(ahead.verdict, "needs-action");
  assert.equal(ahead.reason, "branch-has-unpushed-commits");
  assert.equal(ahead.repo.publication.relation, "ahead");

  const other = join(scratch, "other");
  await git(scratch, "clone", "--branch", "feat/pr-state", remote, other);
  await git(other, "config", "user.name", "Remote Test");
  await git(other, "config", "user.email", "remote@example.com");
  await writeFile(join(other, "remote.txt"), "remote advance\n");
  await git(other, "add", "remote.txt");
  await git(other, "commit", "-m", "advance remote branch");
  await git(other, "push", "origin", "HEAD:refs/heads/feat/pr-state");
  await git(repo, "fetch", "origin", "feat/pr-state");

  const diverged = await preflightDelivery({ cwd: repo, operation: "pr" });
  assert.equal(diverged.verdict, "blocked");
  assert.equal(diverged.reason, "branch-not-current-with-origin");
  assert.equal(diverged.repo.publication.relation, "diverged");
});

test("origin HEAD may name a non-main trunk and the launcher exposes the preflight", async (t) => {
  const { repo } = await fixture(t, { trunk: "develop" });
  const configBefore = await readFile(join(repo, ".git", "config"), "utf8");

  const trunk = await commitPreflight(repo);
  assert.equal(trunk.verdict, "blocked");
  assert.equal(trunk.reason, "on-trunk");
  assert.equal(trunk.repo.base.name, "develop");
  assert.equal(trunk.repo.base.source, "origin-head");

  await git(repo, "switch", "-c", "feat/launcher");
  await writeFile(join(repo, "safe.txt"), "safe\n");
  await git(repo, "add", "safe.txt");
  const messageFile = join(repo, ".git", "COMMIT_MESSAGE_TEST");
  await writeFile(messageFile, "safe feature\n");
  const { stdout } = await exec(
    LAUNCHER,
    ["git-delivery-preflight", "--operation", "commit", "--message-file", messageFile],
    { cwd: repo },
  );
  const launched = JSON.parse(stdout);
  assert.equal(launched.verdict, "ready");
  assert.equal(launched.operation, "commit");
  assert.equal(await readFile(join(repo, ".git", "config"), "utf8"), configBefore);
});

test("preflight CLI drains large JSON before exiting with a slow pipe reader", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/piped-preflight");
  await mkdir(join(repo, "binaries"));
  await Promise.all(Array.from({ length: 400 }, (_, index) => writeFile(
    join(repo, "binaries", `runtime-${index}-${"x".repeat(160)}.bin`),
    Buffer.from([0, 1, 2]),
  )));
  await git(repo, "add", "binaries");
  const message = "safe feature\n";
  const messageFile = join(repo, ".git", "COMMIT_MESSAGE_TEST");
  await writeFile(messageFile, message);

  const child = spawn(
    LAUNCHER,
    ["git-delivery-preflight", "--operation", "commit", "--message-file", messageFile],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    let stdout = "";
    for await (const chunk of child.stdout) stdout += chunk;
    const [status] = await closed;
    assert.equal(status, 0);
    assert.equal(stderr, "");
    const expected = preflightDelivery({ cwd: repo, operation: "commit", message });
    assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 64 * 1024);
    assert.deepEqual(JSON.parse(stdout), expected);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("delivery skill keeps commit, push, and PR authority separate", async () => {
  const body = await readFile(
    join(PLUGIN_ROOT, "skills", "coredoc-git-delivery", "SKILL.md"),
    "utf8",
  );
  assert.match(body, /preflight.*read-only|read-only.*preflight/is);
  assert.match(body, /commit.*does not authorize.*push/is);
  assert.match(body, /push.*does not authorize.*(?:PR|pull request)/is);
  assert.match(body, /never.*(?:automatically )?stage|do not.*stage/is);
  assert.match(body, /no automatic.*fetch|do not.*fetch/is);
  assert.match(body, /never.*force-push|do not.*force-push/is);
  assert.match(body, /existing.*pull request.*(?:found|none|unknown)/is);
  assert.match(body, /query.*fail.*unknown|unknown.*query.*fail/is);
  assert.match(body, /git-delivery-preflight --operation/);
  assert.match(body, /--message-file <temporary-message-file>/);
  assert.match(body, /commit\.indexFingerprint/);
  assert.match(body, /commit\.messageFingerprint/);
  assert.match(body, /git commit --cleanup=verbatim --file <temporary-message-file>/);
  assert.match(body, /--verify-created <created-commit-sha>/);
  assert.match(body, /--expected-parent <scanned-parent-sha>/);
  assert.match(body, /--expected-index <scanned-index-fingerprint>/);
  assert.match(body, /--expected-message <scanned-message-fingerprint>/);
  assert.match(body, /do\s+not\s+bypass repository hooks/i);
  assert.match(body, /do not push it/i);
  assert.match(body, /current\s+HEAD.*scanned commit|scanned commit.*current\s+HEAD/is);
  assert.match(body, /<scanned-commit-sha>:refs\/heads\/<branch>/);
  assert.doesNotMatch(body, /origin HEAD:refs\/heads\/<branch>/);
  assert.match(body, /--no-follow-tags/);
  assert.match(body, /remote\.origin\.mirror=false/);
  assert.match(body, /--recurse-submodules=no/);
  assert.doesNotMatch(body, /--set-upstream(?:\s|\])/);
  assert.match(body, /push\.configureUpstream/);
  assert.match(body, /branch --set-upstream-to=origin\/<branch> <branch>/);
  assert.doesNotMatch(body, /REST fallback|create_pr\.py/i);
});


test("commit preflight refuses a same-HEAD switch to another branch", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/intended");
  await writeFile(join(repo, "safe.txt"), "safe content\n");
  await git(repo, "add", "safe.txt");
  const before = await commitPreflight(repo);
  await git(repo, "switch", "-c", "feat/other");
  const after = preflightDelivery({ cwd: repo, operation: "commit",
    message: "safe test commit\n", expectedBranch: before.repo.branch });
  assert.equal(after.repo.head, before.repo.head);
  assert.equal(after.verdict, "blocked");
  assert.equal(after.reason, "branch-drift");
});

test("created commit verification refuses the wrong branch even with matching tree and parent", async (t) => {
  const { repo } = await fixture(t);
  await git(repo, "switch", "-c", "feat/intended");
  await writeFile(join(repo, "safe.txt"), "safe content\n");
  await git(repo, "add", "safe.txt");
  const before = await commitPreflight(repo, "safe feature");
  await git(repo, "switch", "-c", "feat/other");
  await git(repo, "commit", "-m", "safe feature");
  const commit = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  const result = verifyCreatedCommit({ cwd: repo, commit,
    expectedBranch: before.repo.branch, expectedParent: before.repo.head,
    expectedIndexFingerprint: before.commit.indexFingerprint,
    expectedMessageFingerprint: before.commit.messageFingerprint });
  assert.equal(result.verdict, "blocked");
  assert.equal(result.reason, "branch-drift");
});
