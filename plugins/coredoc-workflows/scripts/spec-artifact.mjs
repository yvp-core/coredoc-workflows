/**
 * The specification artifact a run is about: how its path is stored, and the
 * two frontmatter keys the gates read (`status`, `run`).
 *
 * Deliberately not a YAML parser: only those keys, only from the leading
 * frontmatter block, only as trimmed scalars. Anything else in the document is
 * never read and never rewritten.
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

// An empty block (`---\n---\n`) is a document that declares nothing, which is
// not the same as a document without frontmatter, so the body is optional.
const FRONTMATTER = /^(---(\r?\n))((?:[\s\S]*?\r?\n)?)(---(?:\r?\n|$))/;
const SCALAR_LINE = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const READ_KEYS = new Set(["status", "run"]);

/**
 * The leading frontmatter split into its parts, preserving the document's own
 * line separator so a rewrite never converts CRLF to LF.
 */
function frontmatterBlock(text) {
  const block = FRONTMATTER.exec(text);
  if (!block) return undefined;
  const [matched, open, eol, body, close] = block;
  const trimmed = body.endsWith(eol) ? body.slice(0, -eol.length) : body;
  return {
    open,
    eol,
    close,
    lines: trimmed === "" ? [] : trimmed.split(/\r?\n/),
    rest: text.slice(matched.length),
  };
}

/** Repository-relative, forward-slashed, never escaping the repository. */
export function normalizedSpecPath(value, repoRoot = "") {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (raw === "") {
    throw new Error("--spec-path requires a repository-relative path");
  }
  const base = resolve(repoRoot || process.cwd());
  // Resolve first, compare second: a middle `..` (`docs/../../other/spec.md`)
  // leaves the repository just as surely as a leading one, and only the
  // resolved path shows it.
  const absolute = resolve(base, raw);
  const relativePath = relative(base, absolute).replace(/\\/g, "/");
  if (
    relativePath === "" ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith("../")
  ) {
    throw new Error(
      `--spec-path must name a file inside the repository; ${raw} resolves to ${absolute}`,
    );
  }
  if (!resolvesInsideRepository(absolute, base)) {
    throw new Error(
      `--spec-path must name a file inside the repository; ${raw} links outside it`,
    );
  }
  return relativePath;
}

/**
 * A symlinked directory escapes only when it is followed, so the deepest part
 * of the path that exists is checked as it really is. A repository root that
 * is not on disk (a synthetic root in a test) has nothing to follow and passes.
 */
function resolvesInsideRepository(absolute, base) {
  let realBase;
  try {
    realBase = realpathSync(base);
  } catch {
    return true;
  }
  let directory = dirname(absolute);
  for (;;) {
    let real;
    try {
      real = realpathSync(directory);
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return true;
      directory = parent;
      continue;
    }
    const rel = relative(realBase, real);
    return rel === "" || (!isAbsolute(rel) && !rel.startsWith(".."));
  }
}

/** `<repositoryKey>:<repo-relative path>`; `unmapped` when the repo is unknown. */
export function specRefFor(repositoryKey, path) {
  const key =
    typeof repositoryKey === "string" && repositoryKey !== ""
      ? repositoryKey
      : "unmapped";
  return `${key}:${path}`;
}

export function specPathFromRef(specRef) {
  const value = String(specRef ?? "");
  const separator = value.indexOf(":");
  return separator === -1 ? value : value.slice(separator + 1);
}

export function specAbsolutePath(
  specRef,
  { repoRoot = "", cwd = process.cwd() } = {},
) {
  return resolve(repoRoot || cwd, specPathFromRef(specRef));
}

/**
 * The artifact's frontmatter facts, or `undefined` when the file cannot be
 * read. A readable file without frontmatter answers `{}` — it exists but
 * declares nothing, which is not the same as a missing specification.
 */
export function readSpecArtifact(absolutePath) {
  let text;
  try {
    text = readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
  const block = frontmatterBlock(text);
  if (!block) return {};
  const fields = {};
  for (const line of block.lines) {
    const scalar = SCALAR_LINE.exec(line);
    if (!scalar || !READ_KEYS.has(scalar[1])) continue;
    fields[scalar[1]] = scalar[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

/**
 * Set one frontmatter scalar, in place, preserving the rest of the document.
 * Returns false when the file has no frontmatter block to write into.
 */
export function writeSpecArtifactKey(absolutePath, key, value) {
  return rewriteFrontmatter(absolutePath, (lines) => {
    const index = lines.findIndex((line) => SCALAR_LINE.exec(line)?.[1] === key);
    if (index === -1) return [...lines, `${key}: ${value}`];
    return lines.map((line, at) => (at === index ? `${key}: ${value}` : line));
  });
}

/**
 * Drop one frontmatter scalar. The `run:` pointer exists only while a run is
 * waiting for its acceptance; once the run is gone the document must not keep
 * pointing at it.
 */
export function removeSpecArtifactKey(absolutePath, key) {
  return rewriteFrontmatter(absolutePath, (lines) =>
    lines.filter((line) => SCALAR_LINE.exec(line)?.[1] !== key),
  );
}

function rewriteFrontmatter(absolutePath, transform) {
  let text;
  try {
    text = readFileSync(absolutePath, "utf8");
  } catch {
    return false;
  }
  const block = frontmatterBlock(text);
  if (!block) return false;
  const lines = transform(block.lines);
  // The separator is the document's own, so a CRLF file stays CRLF.
  const body = lines.length === 0 ? "" : `${lines.join(block.eol)}${block.eol}`;
  writeFileSync(absolutePath, `${block.open}${body}${block.close}${block.rest}`, {
    encoding: "utf8",
  });
  return true;
}
