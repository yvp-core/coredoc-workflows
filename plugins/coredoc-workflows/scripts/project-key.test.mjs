import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "../test/test-api.mjs";
import {
  cacheDir,
  persistentDir,
  persistentDirs,
  resolveProjectKey,
  resolveRepositoryScopeKey,
  stateRoot,
} from "./project-key.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "coredoc-project-key-"));

function gitInit(dir) {
  const run = (...args) =>
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  run("init", "-q");
  return dir;
}

// ── Root ────────────────────────────────────────────────────────────────────

test("state root defaults under ~/.coredoc, not a macOS-only cache path", () => {
  const root = stateRoot({});
  assert.ok(root.endsWith(`${sep}.coredoc`), `unexpected root: ${root}`);
  assert.ok(!root.includes("Library"), "root must not be macOS-specific");
});

test("state root honours both overrides", () => {
  assert.equal(stateRoot({ COREDOC_HOME: "/custom" }), "/custom");
  assert.equal(
    stateRoot({ COREDOC_WORKFLOWS_STATE_HOME: "/state", COREDOC_HOME: "/custom" }),
    "/state",
    "the workflows-specific override wins",
  );
});

// ── Key precedence ──────────────────────────────────────────────────────────

test("an explicit repo key wins over everything", () => {
  const dir = scratch();
  assert.equal(resolveProjectKey(dir, { COREDOC_WORKFLOWS_REPO_KEY: "chosen-key" }), "chosen-key");
});

test("an explicit repo key with unsafe characters is ignored, not used as a path", () => {
  const dir = scratch();
  const key = resolveProjectKey(dir, { COREDOC_WORKFLOWS_REPO_KEY: "../escape" });
  assert.notEqual(key, "../escape");
  assert.ok(!key.includes("/"), "a key must never contain a path separator");
});

test("dot segments are never accepted as project keys", () => {
  for (const override of [".", ".."]) {
    const dir = scratch();
    const key = resolveProjectKey(dir, { COREDOC_WORKFLOWS_REPO_KEY: override });
    assert.notEqual(key, override);
    assert.ok(![".", ".."].includes(key));
  }
});

test("the project id is taken from a config that actually claims this directory", () => {
  const dir = scratch();
  const repo = join(dir, "svc");
  mkdirSync(repo);
  writeFileSync(
    join(dir, "coredoc.config.json"),
    JSON.stringify({ projects: [{ id: "go-proj", name: "go proj", repos: [{ path: repo }] }] }),
  );
  assert.equal(resolveProjectKey(repo, {}), "go-proj");
});

test("invalid configured project ids fall back without escaping the state root", () => {
  for (const id of [".", ".."]) {
    const dir = scratch();
    const repo = join(dir, "svc");
    mkdirSync(repo);
    writeFileSync(
      join(dir, "coredoc.config.json"),
      JSON.stringify({ projects: [{ id, repos: [{ path: repo }] }] }),
    );
    const env = { COREDOC_WORKFLOWS_STATE_HOME: join(dir, "state-root") };
    assert.notEqual(resolveProjectKey(repo, env), id);
    for (const path of persistentDirs(repo, env)) {
      assert.ok(path.startsWith(`${env.COREDOC_WORKFLOWS_STATE_HOME}${sep}`));
    }
  }
});

// `RepoConfig.path` is "relative to config file or absolute". Resolving a
// relative entry against `process.cwd()` instead of the config directory made the
// configured project invisible and sent the run to a path-derived namespace.
test("a repo path relative to the config file is resolved against the config", () => {
  const dir = scratch();
  const repo = join(dir, "api-server");
  mkdirSync(repo);
  writeFileSync(
    join(dir, "coredoc.config.json"),
    JSON.stringify({ projects: [{ id: "rel-proj", repos: [{ path: "./api-server" }] }] }),
  );
  assert.equal(resolveProjectKey(repo, {}), "rel-proj");
});

test("a relative repo path that does not contain this directory is still not adopted", () => {
  const dir = scratch();
  mkdirSync(join(dir, "listed"));
  const other = join(dir, "other");
  mkdirSync(other);
  writeFileSync(
    join(dir, "coredoc.config.json"),
    JSON.stringify({ projects: [{ id: "listed-proj", repos: [{ path: "./listed" }] }] }),
  );
  assert.notEqual(resolveProjectKey(other, {}), "listed-proj");
});

test("a config that does NOT list this directory is not adopted", () => {
  const dir = scratch();
  const listed = join(dir, "listed");
  const other = join(dir, "other");
  mkdirSync(listed);
  mkdirSync(other);
  writeFileSync(
    join(dir, "coredoc.config.json"),
    JSON.stringify({ projects: [{ id: "listed-proj", repos: [{ path: listed }] }] }),
  );
  // A config lists sibling repositories too; sitting beside one is not
  // evidence that this working directory belongs to that project.
  assert.notEqual(resolveProjectKey(other, {}), "listed-proj");
});

test("a project without an id falls back to a slug of its name", () => {
  const dir = scratch();
  const repo = join(dir, "svc");
  mkdirSync(repo);
  writeFileSync(
    join(dir, "coredoc.config.json"),
    JSON.stringify({ projects: [{ name: "Go Proj!", repos: [{ path: repo }] }] }),
  );
  assert.equal(resolveProjectKey(repo, {}), "go-proj");
});

test("malformed config does not throw — it degrades to the path-derived key", () => {
  const dir = gitInit(scratch());
  writeFileSync(join(dir, "coredoc.config.json"), "{ not json");
  const key = resolveProjectKey(dir, {});
  assert.ok(key.length > 0);
  assert.match(key, /-[0-9a-f]{8}$/);
});

// ── Degradation: the plugin must namespace with no Coredoc at all ───────────

test("a git repo with no config gets a readable, unique key", () => {
  const dir = gitInit(scratch());
  const key = resolveProjectKey(dir, {});
  assert.match(key, /^[a-z0-9-]+-[0-9a-f]{8}$/, `unexpected shape: ${key}`);
});

test("two same-named repositories in different places do not collide", () => {
  const repoA = join(scratch(), "svc");
  const repoB = join(scratch(), "svc");
  mkdirSync(repoA);
  mkdirSync(repoB);
  gitInit(repoA);
  gitInit(repoB);
  const keyA = resolveProjectKey(repoA, {});
  const keyB = resolveProjectKey(repoB, {});
  assert.notEqual(keyA, keyB, "same basename must still produce distinct keys");
  assert.ok(keyA.startsWith("svc-") && keyB.startsWith("svc-"), "both stay readable");
});

test("durable repository scopes do not collide when separate configs reuse a project id", () => {
  const workspaceA = scratch();
  const workspaceB = scratch();
  const repoA = join(workspaceA, "svc");
  const repoB = join(workspaceB, "svc");
  mkdirSync(repoA);
  mkdirSync(repoB);
  gitInit(repoA);
  gitInit(repoB);
  for (const [workspace, repo] of [
    [workspaceA, repoA],
    [workspaceB, repoB],
  ]) {
    writeFileSync(
      join(workspace, "coredoc.config.json"),
      JSON.stringify({ projects: [{ id: "app", repos: [{ path: repo }] }] }),
    );
  }

  assert.equal(resolveProjectKey(repoA, {}), "app");
  assert.equal(resolveProjectKey(repoB, {}), "app");
  assert.notEqual(resolveRepositoryScopeKey(repoA), resolveRepositoryScopeKey(repoB));
});

test("linked worktrees share durable scope without executing git", () => {
  const root = scratch();
  const common = join(root, "common");
  const worktrees = join(common, "worktrees");
  const repoA = join(root, "worktree-a");
  const repoB = join(root, "worktree-b");
  mkdirSync(join(worktrees, "a"), { recursive: true });
  mkdirSync(join(worktrees, "b"), { recursive: true });
  mkdirSync(repoA);
  mkdirSync(repoB);
  writeFileSync(join(worktrees, "a", "commondir"), "../..\n");
  writeFileSync(join(worktrees, "b", "commondir"), "../..\n");
  writeFileSync(join(repoA, ".git"), `gitdir: ${join(worktrees, "a")}\n`);
  writeFileSync(join(repoB, ".git"), `gitdir: ${join(worktrees, "b")}\n`);

  assert.equal(resolveRepositoryScopeKey(repoA), resolveRepositoryScopeKey(repoB));
});

test("a plain directory that is not a repository still resolves", () => {
  const dir = scratch();
  const key = resolveProjectKey(dir, {});
  assert.match(key, /-[0-9a-f]{8}$/);
  assert.ok(!key.includes(sep));
});

test("the key is stable across calls", () => {
  const dir = gitInit(scratch());
  assert.equal(resolveProjectKey(dir, {}), resolveProjectKey(dir, {}));
});

// ── Layout ──────────────────────────────────────────────────────────────────

test("cache and state are separate subdirectories under the project key", () => {
  const dir = scratch();
  const env = { COREDOC_HOME: "/root", COREDOC_WORKFLOWS_REPO_KEY: "proj" };
  assert.equal(cacheDir(dir, env), join("/root", "proj", "cache"));
  assert.equal(persistentDir(dir, env), join("/root", "proj", "state"));
});

test("credentials never sit inside the disposable directory", () => {
  const env = { COREDOC_HOME: "/root", COREDOC_WORKFLOWS_REPO_KEY: "proj" };
  const cache = cacheDir(scratch(), env);
  // credentials.json lives at the root of ~/.coredoc; clearing the cache must
  // not be able to reach it.
  assert.ok(!join("/root", "credentials.json").startsWith(cache));
});
