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

  assert.equal(pkg.version, "0.11.4");
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
  const captureManifest = await json(
    join(pluginRoot, "runtime", "capture-agent-manifest.json"),
  );
  assert.deepEqual(
    captureManifest.files.find(
      ({ path }) => path === `runtime/bun/${provenance.binary}`,
    ),
    { path: `runtime/bun/${provenance.binary}`, sha256: provenance.sha256 },
  );
  const installedRunner = await stat(join(pluginRoot, "runtime", "bun", "runner"));
  assert.notEqual(installedRunner.mode & 0o111, 0, "runtime runner must be executable");
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
  assert.equal(await verifyRelease("v0.11.4"), "0.11.4");
  await assert.rejects(verifyRelease("v0.11.1"), /tag does not match/);
});

test("documents opt-in plugin-managed capture without changing the core runtime contract", async () => {
  const documents = await Promise.all([
    readFile(join(root, "README.md"), "utf8"),
    readFile(join(root, "SECURITY.md"), "utf8"),
    readFile(join(root, "CONTRIBUTING.md"), "utf8"),
    readFile(join(pluginRoot, "README.md"), "utf8"),
    readFile(join(root, "docs", "plugin-managed-capture-agent.md"), "utf8"),
  ]);

  for (const document of documents) {
    assert.match(document, /capture-agent-policy\.json/);
  }
  assert.match(documents[0], /does \*\*not\*\* register a LaunchAgent/);
  assert.match(documents[0], /no system Node, Bun, or Python/i);
  assert.match(documents[1], /disabled by default/i);
  assert.match(documents[1], /pinned Bun executable/i);
  assert.match(documents[2], /contributor\/reference compatibility/i);
  assert.match(documents[3], /Coredoc Desktop is not required/);
  assert.match(documents[3], /no system Node, Bun, or Python/i);
  assert.match(documents[4], /No system Node, Bun, or Python/i);
  for (const document of [documents[0], documents[1], documents[3], documents[4]]) {
    assert.doesNotMatch(document, /system Node\.js 22|external Node/i);
  }
  assert.match(documents[4], /"schemaVersion": 1/);
  assert.match(documents[4], /"serverOrigin": "<https-origin>"/);
  assert.match(documents[4], /"workspaceId": "<workspace-uuid>"/);
  assert.match(documents[4], /chmod 600 ~\/\.coredoc\/capture-agent-policy\.json/);
  assert.match(documents[4], /capture setup/);
  assert.match(documents[4], /capture uninstall --purge/);

  for (const document of [documents[0], documents[1], documents[3]]) {
    assert.match(document, /COREDOC_CAPTURE_ENDPOINT/);
    assert.match(document, /COREDOC_CAPTURE_HEADERS/);
  }
});

test("advertises the optional capture agent without changing OSS release identity", async () => {
  const codex = await json(join(pluginRoot, ".codex-plugin", "plugin.json"));
  const claude = await json(join(pluginRoot, ".claude-plugin", "plugin.json"));

  for (const manifest of [codex, claude]) {
    assert.equal(manifest.version, "0.11.4");
    assert.equal(manifest.repository, "https://github.com/yvp-core/coredoc-workflows");
    assert.match(manifest.description, /capture agent/i);
  }
  assert.ok(codex.interface.capabilities.includes("Opt-in macOS capture agent"));
});

test("release checksums contain the downloadable asset name without a dist prefix", async () => {
  const workflow = await readFile(
    join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );

  assert.match(workflow, /\(cd dist && shasum -a 256 "\$\{archive\}" > SHA256SUMS\)/);
  assert.doesNotMatch(workflow, /shasum[^\n]+"dist\/[^\n]+> dist\/SHA256SUMS/);
});
