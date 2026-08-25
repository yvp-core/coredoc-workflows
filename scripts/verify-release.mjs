import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginRoot = join(root, "plugins", "coredoc-workflows");

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function verifyRelease(tag = undefined) {
  const rootPackage = await json(join(root, "package.json"));
  const pluginPackage = await json(join(pluginRoot, "package.json"));
  const codex = await json(join(pluginRoot, ".codex-plugin", "plugin.json"));
  const claude = await json(join(pluginRoot, ".claude-plugin", "plugin.json"));
  const versions = [
    rootPackage.version,
    pluginPackage.version,
    codex.version,
    claude.version,
  ];

  assert.ok(versions.every((version) => version === versions[0]), "release versions differ");
  assert.match(versions[0], /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(pluginPackage.license, "Apache-2.0");
  assert.equal(codex.license, pluginPackage.license);
  assert.equal(claude.license, pluginPackage.license);

  if (tag !== undefined) {
    assert.equal(tag, `v${versions[0]}`, "tag does not match the committed version");
  }

  return versions[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const version = await verifyRelease(process.argv[2]);
    process.stdout.write(`release metadata OK: v${version}\n`);
  } catch (error) {
    process.stderr.write(`release metadata invalid: ${error.message}\n`);
    process.exitCode = 1;
  }
}
