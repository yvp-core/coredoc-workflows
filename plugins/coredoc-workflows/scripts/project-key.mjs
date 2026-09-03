#!/usr/bin/env node
/**
 * project-key — the single resolver for where this plugin keeps local state.
 *
 * Two problems this exists to fix.
 *
 * **Platform.** The previous default was `~/Library/Caches/coredoc-workflows`,
 * hardcoded with no platform branch. That path is macOS-only; on Linux — where
 * the Coredoc CLI runs in CI — it produced a `~/Library/Caches` directory that
 * works but violates every convention and is invisible to anyone looking in the
 * usual place. `~/.coredoc` is platform-neutral and is already where the CLI
 * keeps its credentials and session, so state lives under one discoverable root.
 *
 * **Mixing.** Project-scoped state was not namespaced per project, so browser
 * sessions and reports from unrelated repositories landed together. Active
 * workflow coordination is the exception: one host session can span several
 * repositories, so it lives in the root-level `workflow-runs/` directory.
 *
 * Layout:
 *
 *   ~/.coredoc/
 *     credentials.json          owned by the CLI, mode 0600
 *     session.json              owned by the CLI
 *     workflow-runs/            DISPOSABLE — active session coordination
 *     <project-key>/
 *       cache/                  DISPOSABLE — project-scoped run data,
 *                               browser state, reports.
 *                               Safe to delete; nothing here must survive.
 *       state/                  must survive — anything longitudinal
 *
 * `cache/` is a deliberate subdirectory rather than the project root: credentials
 * sit beside it, and "clear the cache" must never become `rm -rf ~/.coredoc`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** A path segment safe to use as a directory name. */
const KEY_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const REPOSITORY_KEY_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;
const GIT_ORIGIN_PROTOCOLS = new Set([
  "git:",
  "git+ssh:",
  "http:",
  "https:",
  "ssh:",
]);

/** Root for all plugin state. `COREDOC_HOME` overrides for tests and odd setups. */
export function stateRoot(env = process.env) {
  return (
    env.COREDOC_WORKFLOWS_STATE_HOME ?? env.COREDOC_HOME ?? join(homedir(), ".coredoc")
  );
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function repositoryScopeHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function repositoryScopeKey(metadata) {
  return `repo-${repositoryScopeHash(canonicalPath(metadata.commonDir ?? metadata.root))}`;
}

// `project-key.mjs` is copied into the standalone capture runtime without the
// session hook entrypoint, so origin normalization remains self-contained here.
function normalizedRepositoryKeyFromOrigin(origin) {
  if (typeof origin !== "string" || origin === "") return undefined;
  const input = origin.trim();
  let path = input;
  const scp =
    !/^[a-z+]+:\/\//i.test(input) && input.match(/^[^@]+@[^:]+:(.+)$/);
  if (scp) {
    path = scp[1];
  } else if (/^[a-z+]+:\/\//i.test(input)) {
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      return undefined;
    }
    if (
      !GIT_ORIGIN_PROTOCOLS.has(parsed.protocol) ||
      !parsed.hostname ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      ((parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.username)
    ) {
      return undefined;
    }
    path = parsed.pathname.replace(/^\/+/, "");
  }
  path = path.replace(/\.git$/, "");
  const segments = path.split("/");
  return path.length <= 256 &&
    segments.length >= 2 &&
    segments.every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        REPOSITORY_KEY_SEGMENT_RE.test(segment),
    )
    ? path
    : undefined;
}

function canonicalPath(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return resolve(value);
  }
}

function isSafeKeySegment(value) {
  return typeof value === "string" && ![".", ".."].includes(value) && KEY_SEGMENT_RE.test(value);
}

/** Slugify to the same shape `@coredoc/core`'s project ids use, so keys agree. */
function slugify(name) {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "project";
}

/** Nearest `coredoc.config.json` at or above `from`. */
function findConfig(from) {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, "coredoc.config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Whether `child` is `parent` or sits inside it. */
function isInside(child, parent) {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * The project id from a Coredoc config whose repo list actually contains `cwd`.
 *
 * Finding a config above the working directory does not mean the work belongs to
 * one of its projects — a config lists sibling repositories too. Only a repo
 * whose path contains `cwd` proves that.
 *
 * `repo.path` is "relative to config file or absolute" (`RepoConfig.path` in
 * `@coredoc/core`), so it resolves against the config's own directory, the way
 * the product resolves every other config-relative path. A bare `resolve()`
 * would use `process.cwd()` instead, which silently fails to match a configured
 * project and drops the run into a path-derived namespace.
 */
function projectIdFromConfig(cwd, configPath) {
  const configDir = dirname(configPath);
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  for (const project of config?.projects ?? []) {
    for (const repo of project?.repos ?? []) {
      if (repo?.path && isInside(cwd, resolve(configDir, repo.path))) {
        const id = project.id ?? (project.name ? slugify(project.name) : undefined);
        if (id && PROJECT_ID_RE.test(id)) return id;
      }
    }
  }
  return undefined;
}

function boundedGitPointer(path) {
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 4096) return undefined;
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Resolve worktree identity from `.git` metadata without executing ambient PATH binaries. */
function gitMetadata(cwd) {
  let current = canonicalPath(cwd);
  for (;;) {
    const marker = join(current, ".git");
    try {
      const metadata = statSync(marker);
      if (metadata.isDirectory()) return { root: current, commonDir: canonicalPath(marker) };
      if (metadata.isFile()) {
        const pointer = boundedGitPointer(marker)?.match(/^gitdir:\s*(.+)$/i)?.[1];
        if (!pointer) return { root: current, commonDir: canonicalPath(marker) };
        const gitDir = canonicalPath(resolve(current, pointer));
        const commonPointer = boundedGitPointer(join(gitDir, "commondir"));
        const commonDir = commonPointer
          ? canonicalPath(resolve(gitDir, commonPointer))
          : gitDir;
        return { root: current, commonDir };
      }
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The directory-name key for the current project, resolved in precedence order:
 *
 *   1. `COREDOC_WORKFLOWS_REPO_KEY` — explicit override, when it is a single safe
 *      path segment. Note this is NOT the same grammar the run-state contract
 *      uses: `session-env.mjs` exports the variable as `owner/repo`, and a value
 *      containing `/` is rejected here rather than turned into a nested path. In
 *      a hooked session the override therefore does not apply and resolution
 *      falls through to the config id or the path-derived key. Directory layout
 *      and run-state identity are deliberately separate; do not "fix" this by
 *      accepting separators.
 *   2. The project `id` from a `coredoc.config.json` that actually claims this
 *      working directory. This is the id the rest of Coredoc already uses as a
 *      folder name, so the plugin and the product agree.
 *   3. `<repo-name>-<hash of the git root>` — readable enough to recognize in a
 *      listing, hashed so two same-named repositories cannot collide.
 *   4. The same shape from the working directory, when this is not a repository.
 *
 * The plugin is self-contained: steps 3 and 4 mean it namespaces correctly with
 * no Coredoc installation and on a repository that was never parsed.
 *
 * A key can change — adding a Coredoc config promotes a path-derived key to a
 * project id. `persistentDirs()` preserves the fallback namespace for durable
 * state; disposable cache callers intentionally use only the current primary key.
 */
export function resolvePathProjectKey(cwd = process.cwd()) {
  const root = canonicalPath(gitMetadata(cwd)?.root ?? cwd);
  return `${slugify(basename(root))}-${shortHash(root)}`;
}

export function resolveProjectKey(cwd = process.cwd(), env = process.env) {
  const override = env.COREDOC_WORKFLOWS_REPO_KEY;
  if (isSafeKeySegment(override)) return override;

  const configPath = findConfig(cwd);
  if (configPath) {
    const id = projectIdFromConfig(cwd, configPath);
    if (id) return id;
  }

  return resolvePathProjectKey(cwd);
}

function normalizedOriginFor(metadata) {
  let origin;
  try {
    origin = execFileSync(
      "git",
      ["-C", metadata.root, "config", "--get", "remote.origin.url"],
      {
        encoding: "utf8",
        timeout: 1_000,
        maxBuffer: 4_096,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return undefined;
  }
  return normalizedRepositoryKeyFromOrigin(origin);
}

function authoritativeRepositoryKey(value) {
  if (value === undefined) return undefined;
  const normalized = normalizedRepositoryKeyFromOrigin(value);
  if (!normalized || normalized !== value) {
    throw new Error("authoritative repository key must already be normalized");
  }
  return normalized;
}

/**
 * Repository identity for attribution-sensitive callers.
 *
 * `null` is the explicit non-repository state. A Git repository without a
 * server-approved mapping is `unmapped`; its normalized origin is only a lookup
 * candidate and is never promoted to `repositoryKey`. Only the caller-supplied
 * authoritative key can produce `known`.
 */
export function resolveRepositoryIdentity(
  cwd = process.cwd(),
  { authoritativeRepositoryKey: mappedRepositoryKey } = {},
) {
  const metadata = gitMetadata(cwd);
  if (!metadata) return null;

  const mapped = authoritativeRepositoryKey(mappedRepositoryKey);
  const normalizedRepositoryKey = normalizedOriginFor(metadata);
  return {
    state: mapped === undefined ? "unmapped" : "known",
    repositoryScopeKey: repositoryScopeKey(metadata),
    ...(normalizedRepositoryKey === undefined
      ? {}
      : { normalizedRepositoryKey }),
    ...(mapped === undefined ? {} : { repositoryKey: mapped }),
  };
}

export class RepositoryUnavailableError extends Error {
  constructor() {
    super("REPOSITORY_UNAVAILABLE");
    this.name = "RepositoryUnavailableError";
    this.code = "REPOSITORY_UNAVAILABLE";
  }
}

/** Require a normalized local lookup candidate for relay-resolved operations. */
export function requireRepositoryCandidate(identity) {
  if (!identity?.normalizedRepositoryKey) {
    throw new RepositoryUnavailableError();
  }
  return identity.normalizedRepositoryKey;
}

/** Stable, non-secret identity used below a readable project namespace. */
export function resolveRepositoryScopeKey(cwd = process.cwd()) {
  const metadata = gitMetadata(cwd);
  if (metadata) return repositoryScopeKey(metadata);
  return `repo-${repositoryScopeHash(canonicalPath(resolve(cwd)))}`;
}

function projectStatePath(cwd, env, leaf) {
  const root = resolve(stateRoot(env));
  const candidate = resolve(root, resolveProjectKey(cwd, env), leaf);
  if (!candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Project state path escapes its configured root: ${candidate}`);
  }
  return candidate;
}

/** Disposable state for this project. Safe to delete at any time. */
export function cacheDir(cwd = process.cwd(), env = process.env) {
  return projectStatePath(cwd, env, "cache");
}

/** State that must survive for this project. */
export function persistentDir(cwd = process.cwd(), env = process.env) {
  return projectStatePath(cwd, env, "state");
}

/**
 * Candidate homes for longitudinal state, newest namespace first.
 *
 * Adding a Coredoc config promotes a repository from its path-derived key to a
 * project id. Keep the old path-derived namespace readable so that durable
 * conversations are not orphaned by that otherwise-benign configuration edit.
 */
export function persistentDirs(cwd = process.cwd(), env = process.env) {
  const primary = persistentDir(cwd, env);
  const root = resolve(stateRoot(env));
  const fallback = resolve(root, resolvePathProjectKey(cwd), "state");
  if (!fallback.startsWith(`${root}${sep}`)) {
    throw new Error(`Persistent state path escapes its configured root: ${fallback}`);
  }
  return primary === fallback ? [primary] : [primary, fallback];
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] ?? "--cache";
  const out =
    mode === "--key"
      ? resolveProjectKey()
      : mode === "--state"
        ? persistentDir()
        : cacheDir();
  process.stdout.write(`${out}\n`);
}
