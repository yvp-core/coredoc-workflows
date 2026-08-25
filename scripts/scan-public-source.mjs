import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { scanText } from "../plugins/coredoc-workflows/scripts/redact-scan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const textExtensions = new Set([
  ".json",
  ".md",
  ".mjs",
  ".toml",
  ".tmpl",
  ".yaml",
  ".yml",
]);
const textNames = new Set([
  ".gitattributes",
  ".gitignore",
  "LICENSE",
  "coredoc-workflows",
]);
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const maxBytes = 5 * 1024 * 1024;

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (
      entry.isFile() &&
      (textExtensions.has(extname(entry.name)) || textNames.has(entry.name))
    ) {
      files.push(path);
    }
  }
  return files;
}

let count = 0;
for (const path of await sourceFiles(root)) {
  const metadata = await stat(path);
  if (metadata.size > maxBytes) {
    throw new Error(`text source exceeds scan bound: ${relative(root, path)}`);
  }
  const findings = scanText(await readFile(path, "utf8")).filter(
    ({ tier }) => tier === "HIGH",
  );
  for (const finding of findings) {
    count += 1;
    process.stderr.write(
      `${finding.id} ${relative(root, path)}:${finding.line} ${finding.masked}\n`,
    );
  }
}

if (count > 0) {
  process.stderr.write(`public-source scan found ${count} HIGH finding(s)\n`);
  process.exitCode = 2;
} else {
  process.stdout.write("public-source scan: no HIGH findings\n");
}
