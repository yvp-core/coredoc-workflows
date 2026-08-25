import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
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
