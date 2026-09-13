import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "../test/test-api.mjs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(pluginRoot, "bin", "coredoc-workflows");
const unsupported = ["darwin-arm64", "linux-x64"].includes(`${process.platform}-${process.arch}`)
  ? false : "no bundled runtime for this host";
test("launcher uses its bundled runtime with no global Node or Bun on PATH", { skip: unsupported }, async () => {
  const { stdout } = await run(launcher, ["version"], {
    env: { PATH: "/usr/bin:/bin" },
  });
  assert.equal(stdout.trim(), "1.3.14");
});

test("launcher works from an installation path containing spaces", { skip: unsupported }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "coredoc workflow runtime "));
  const linkedRoot = join(scratch, "plugin with spaces");
  await symlink(pluginRoot, linkedRoot);

  const { stdout } = await run(
    join(linkedRoot, "bin", "coredoc-workflows"),
    ["version"],
    { env: { PATH: "/usr/bin:/bin" } },
  );
  assert.equal(stdout.trim(), "1.3.14");
});

test("launcher ignores ambient preload flags and project dotenv files", { skip: unsupported }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "coredoc-runtime-env-"));
  await writeFile(
    join(scratch, ".env"),
    "COREDOC_WORKFLOWS_REPO_KEY=dotenv-must-not-load\n",
  );

  const { stdout } = await run(launcher, ["project-key"], {
    cwd: scratch,
    env: {
      PATH: "/usr/bin:/bin",
      BUN_OPTIONS: "--preload=/definitely/not/present.mjs",
      BUN_INSPECT_PRELOAD: "/definitely/not/present.mjs",
      NODE_OPTIONS: "--require=/definitely/not/present.cjs",
    },
  });
  assert.notEqual(stdout.trim(), "dotenv-must-not-load");
});

test("launcher routes capture lifecycle through bundled Bun without replacing JSON-stdin capture", { skip: unsupported }, async () => {
  const emptyPath = await mkdtemp(join(tmpdir(), "coredoc-no-runtime-path-"));
  const root = await mkdtemp(join(tmpdir(), "coredoc-capture-launcher-"));
  const env = {
    PATH: emptyPath,
    HOME: root,
    COREDOC_HOME: join(root, ".coredoc"),
  };
  const { stdout } = await run(launcher, ["capture", "status"], { env });
  const status = JSON.parse(stdout);
  assert.equal(status.command, "status");
  if (status.listener === "occupied") {
    assert.equal(status.status, "degraded");
    assert.deepEqual(status.degradedReasons, ["FOREIGN_LISTENER"]);
  } else {
    assert.equal(status.listener, "free");
    assert.equal(status.status, "not-installed");
    assert.deepEqual(status.degradedReasons, []);
  }

  const recorder = spawnSync(launcher, ["capture"], {
    env,
    input: "{}",
    encoding: "utf8",
  });
  assert.equal(recorder.status, 1);
  assert.match(recorder.stderr, /Unsupported capture action/);
  assert.doesNotMatch(recorder.stderr, /INVALID_ARGUMENTS/);
});

test("launcher fails closed when the host's vendored Bun is missing", { skip: unsupported }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "coredoc-launcher-missing-bun-"));
  await mkdir(join(scratch, "bin"), { recursive: true });
  await copyFile(launcher, join(scratch, "bin", "coredoc-workflows"));
  await chmod(join(scratch, "bin", "coredoc-workflows"), 0o755);
  const result = spawnSync(join(scratch, "bin", "coredoc-workflows"), ["version"], {
    env: { PATH: "/usr/bin:/bin" }, encoding: "utf8",
  });
  assert.equal(result.status, 70);
  assert.match(result.stderr, /bundled runtime is missing or not executable/);
});
