import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "../plugins/coredoc-workflows/test/test-api.mjs";

import { verifyRelease } from "../scripts/verify-release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(root, "plugins", "coredoc-workflows");

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("publishes one installable plugin through Codex and Claude marketplaces", async () => {
  const codex = await json(join(root, ".agents", "plugins", "marketplace.json"));
  const claude = await json(join(root, ".claude-plugin", "marketplace.json"));

  assert.equal(codex.name, "coredoc-workflows");
  assert.equal(codex.plugins.length, 1);
  assert.equal(codex.plugins[0].name, "coredoc-workflows");
  assert.deepEqual(codex.plugins[0].source, {
    source: "local",
    path: "./plugins/coredoc-workflows",
  });
  assert.equal(codex.plugins[0].policy.authentication, "ON_INSTALL");

  assert.equal(claude.name, "coredoc-workflows");
  assert.equal(claude.plugins.length, 1);
  assert.equal(claude.plugins[0].name, "coredoc-workflows");
  assert.equal(claude.plugins[0].source, "./plugins/coredoc-workflows");
});

test("keeps package and plugin release metadata aligned", async () => {
  const pkg = await json(join(pluginRoot, "package.json"));
  const codex = await json(join(pluginRoot, ".codex-plugin", "plugin.json"));
  const claude = await json(join(pluginRoot, ".claude-plugin", "plugin.json"));

  assert.equal(pkg.version, "0.11.0");
  assert.equal(codex.version, pkg.version);
  assert.equal(claude.version, pkg.version);
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(codex.license, pkg.license);
  assert.equal(claude.license, pkg.license);
  assert.equal(pkg.repository.url, "https://github.com/yvp-core/coredoc-workflows.git");

  await access(join(pluginRoot, "LICENSE"), constants.R_OK);
  assert.match(await readFile(join(pluginRoot, "LICENSE"), "utf8"), /Apache License/);
});

test("uses the bundled, pinned runtime instead of a global Node or Bun", async () => {
  const launcher = join(pluginRoot, "bin", "coredoc-workflows");
  const launcherStat = await stat(launcher);
  assert.notEqual(launcherStat.mode & 0o111, 0, "launcher must be executable");

  const provenance = await json(join(pluginRoot, "runtime", "bun", "provenance.json"));
  const binary = join(pluginRoot, "runtime", "bun", provenance.binary);
  const bytes = await readFile(binary);

  assert.equal(provenance.version, "1.3.14");
  assert.equal(provenance.platform, "darwin-arm64");
  assert.equal(bytes.byteLength, provenance.sizeBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.sha256);
  const license = await readFile(join(pluginRoot, "runtime", "bun", provenance.license.path));
  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    provenance.license.sha256,
  );

  const hooks = await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8");
  assert.doesNotMatch(hooks, /\b(?:node|bun)\s+/);
  assert.match(hooks, /bin\/coredoc-workflows/);
});

test("documents the runtime trust boundary without claiming source reproducibility", async () => {
  const notices = await readFile(join(pluginRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  const browser = await json(join(pluginRoot, "runtime", "browse", "provenance.json"));

  assert.match(notices, /Bun 1\.3\.14/);
  assert.match(browser.comment, /THIRD_PARTY_NOTICES\.md/);
  assert.equal(browser.toolchain.runtime, "Bun 1.1.13");
  assert.equal(browser.reproducibleBuild, false);
  const browserLicense = await readFile(
    join(pluginRoot, "runtime", "browse", browser.runtimeLicense.path),
  );
  assert.equal(
    createHash("sha256").update(browserLicense).digest("hex"),
    browser.runtimeLicense.sha256,
  );
});

test("release tags must match the aligned committed version", async () => {
  assert.equal(await verifyRelease("v0.11.0"), "0.11.0");
  await assert.rejects(verifyRelease("v0.11.1"), /tag does not match/);
});

test("documents both opt-in capture paths without implying installation enables them", async () => {
  const documents = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "SECURITY.md"), "utf8"),
    readFile(join(pluginRoot, "README.md"), "utf8"),
  ]);

  for (const document of documents) {
    assert.match(document, /COREDOC_CAPTURE_ENDPOINT/);
    assert.match(document, /COREDOC_CAPTURE_HEADERS/);
  }
  assert.match(documents[0], /Installation never creates or discovers/);
  assert.match(documents[1], /installation supplies neither value/i);
});

test("release checksums contain the downloadable asset name without a dist prefix", async () => {
  const workflow = await readFile(
    join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );

  assert.match(workflow, /\(cd dist && shasum -a 256 "\$\{archive\}" > SHA256SUMS\)/);
  assert.doesNotMatch(workflow, /shasum[^\n]+"dist\/[^\n]+> dist\/SHA256SUMS/);
});
