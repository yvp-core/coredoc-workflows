import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "../test/test-api.mjs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(pluginRoot, "bin", "coredoc-workflows");
const unsupported =
  process.platform === "darwin" && process.arch === "arm64"
    ? false
    : "bundled runtime supports darwin-arm64 only";
const systemNode = process.versions.bun
  ? execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim()
  : process.execPath;

async function pathWithNode() {
  const scratch = await mkdtemp(join(tmpdir(), "coredoc-node-path-"));
  await symlink(systemNode, join(scratch, "node"));
  return scratch;
}

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

test("launcher routes capture lifecycle through Node without replacing JSON-stdin capture", { skip: unsupported }, async () => {
  const nodePath = await pathWithNode();
  const root = await mkdtemp(join(tmpdir(), "coredoc-capture-launcher-"));
  const env = {
    PATH: nodePath,
    HOME: root,
    COREDOC_HOME: join(root, ".coredoc"),
  };
  const { stdout } = await run(launcher, ["capture", "status"], { env });
  assert.equal(JSON.parse(stdout).command, "status");
  assert.equal(JSON.parse(stdout).status, "not-installed");

  const recorder = spawnSync(launcher, ["capture"], {
    env,
    input: "{}",
    encoding: "utf8",
  });
  assert.equal(recorder.status, 1);
  assert.match(recorder.stderr, /Unsupported capture action/);
  assert.doesNotMatch(recorder.stderr, /INVALID_ARGUMENTS/);
});

test("capture lifecycle rejects Node versions older than 22", { skip: unsupported }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "coredoc-old-node-"));
  const fakeNode = join(scratch, "node");
  await writeFile(
    fakeNode,
    "#!/bin/sh\nif [ \"${1:-}\" = \"-p\" ]; then case \"$2\" in *bun*) printf 'node\\n' ;; *) printf '20\\n' ;; esac; exit 0; fi\nexit 99\n",
  );
  await chmod(fakeNode, 0o755);

  await assert.rejects(
    run(launcher, ["capture", "status"], { env: { PATH: scratch } }),
    (error) => {
      assert.equal(error.code, 69);
      assert.match(error.stderr, /Node\.js 22 or newer/);
      return true;
    },
  );
});

test("capture lifecycle reports when Node is unavailable", { skip: unsupported }, async () => {
  const emptyPath = await mkdtemp(join(tmpdir(), "coredoc-no-node-"));
  await assert.rejects(
    run(launcher, ["capture", "status"], { env: { PATH: emptyPath } }),
    (error) => {
      assert.equal(error.code, 69);
      assert.match(error.stderr, /requires Node\.js 22 or newer/);
      return true;
    },
  );
});
