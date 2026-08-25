import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "../test/test-api.mjs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildPeerPrompt,
  checkProvider,
  loadSession,
  MAX_PROMPT_BYTES,
  parseBridgeArgs,
  providerEnvironment,
  readBoundedText,
  resetSession,
  resolveProviderBinary,
  runBridge,
  runProcess,
  safeProviderDiagnostic,
  saveSession,
  sessionFile,
} from "./cross-model-runtime.mjs";
import {
  claudeInvocation,
  parseClaudeOutput,
} from "../skills/coredoc-claude/scripts/run.mjs";
import {
  codexInvocation,
  parseCodexOutput,
} from "../skills/coredoc-codex/scripts/run.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

test("bridge arguments keep paid calls explicit and provider-specific", () => {
  assert.deepEqual(parseBridgeArgs(["--check"]), {
    action: "check",
    contextFiles: [],
    effort: "high",
    grounding: "artifact",
    sessionKey: "default",
    timeoutMs: 600_000,
  });

  assert.deepEqual(
    parseBridgeArgs([
      "--action",
      "review",
      "--base",
      "origin/main",
      "--model",
      "peer-model-1",
      "--grounding",
      "artifact",
      "--context-file",
      "plan.md",
    ]),
    {
      action: "review",
      baseRef: "origin/main",
      contextFiles: ["plan.md"],
      effort: "high",
      grounding: "artifact",
      model: "peer-model-1",
      sessionKey: "default",
      timeoutMs: 600_000,
    },
  );

  assert.equal(
    parseBridgeArgs([
      "--action",
      "new",
      "--prompt",
      "question.md",
      "--model",
      "peer-model",
      "--session-key",
      "architecture",
    ]).action,
    "new",
  );
  assert.equal(
    parseBridgeArgs([
      "--action",
      "continue",
      "--prompt",
      "follow-up.md",
      "--session-key",
      "architecture",
    ]).action,
    "continue",
  );
  assert.equal(parseBridgeArgs(["--action", "status"]).action, "status");
  assert.equal(parseBridgeArgs(["--action", "reset"]).action, "reset");

  assert.throws(() => parseBridgeArgs([]), /--action or --check/);
  assert.throws(
    () =>
      parseBridgeArgs([
        "--action",
        "review",
        "--artifact",
        "a.md",
        "--base",
        "main",
        "--model",
        "peer-model",
      ]),
    /exactly one of --artifact or --base/,
  );
  assert.throws(
    () => parseBridgeArgs(["--action", "new", "--prompt", "q.md"]),
    /requires --model/,
  );
  assert.throws(
    () => parseBridgeArgs(["--action", "status", "--model", "peer-model"]),
    /does not accept --model/,
  );
  assert.throws(() => parseBridgeArgs(["--provider", "claude"]), /Unknown argument/);
  assert.throws(
    () => parseBridgeArgs(["--check", "--action", "reset"]),
    /--check does not accept other arguments/,
  );
  assert.throws(
    () =>
      parseBridgeArgs([
        "--action",
        "review",
        "--artifact",
        "a.md",
        "--model",
        "peer-model",
        "--grounding",
        "repo",
      ]),
    /native repository grounding is not an egress-safe boundary/,
  );
});

test("provider executable resolution ignores relative PATH entries and rejects repo binaries", async () => {
  const outside = await mkdtemp(join(tmpdir(), "coredoc-peer-bin-"));
  const repository = await mkdtemp(join(tmpdir(), "coredoc-peer-repo-"));
  const inside = join(repository, "bin");
  await mkdir(inside, { recursive: true });
  const outsideBinary = join(outside, "claude");
  const insideBinary = join(inside, "claude");
  await writeFile(outsideBinary, "#!/bin/sh\nexit 0\n");
  await writeFile(insideBinary, "#!/bin/sh\nexit 0\n");
  await chmod(outsideBinary, 0o755);
  await chmod(insideBinary, 0o755);

  assert.equal(
    await resolveProviderBinary("claude", {
      cwd: repository,
      env: { PATH: `relative:${outside}` },
    }),
    await realpath(outsideBinary),
  );
  await assert.rejects(
    resolveProviderBinary("claude", { cwd: repository, env: { PATH: inside } }),
    /inside the repository/,
  );
  await assert.rejects(
    resolveProviderBinary("claude", { cwd: repository, env: { PATH: "relative" } }),
    /absolute PATH entry/,
  );
});

test("provider environment is an exact allowlist", () => {
  const source = {
    HOME: "/tmp/home",
    PATH: "/usr/bin:/bin",
    ANTHROPIC_API_KEY: "anthropic-secret",
    CLAUDE_CONFIG_DIR: "/tmp/claude",
    OPENAI_API_KEY: "openai-secret",
    CODEX_HOME: "/tmp/codex",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    SSH_AUTH_SOCK: "/tmp/agent",
    CLAUDE_MALICIOUS_EXTRA: "no",
    RANDOM_SECRET: "no",
  };

  assert.deepEqual(providerEnvironment("claude", source, "/opt/claude"), {
    HOME: "/tmp/home",
    PATH: ["/opt", dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    ANTHROPIC_API_KEY: "anthropic-secret",
    CLAUDE_CONFIG_DIR: "/tmp/claude",
  });
  assert.deepEqual(providerEnvironment("codex", source, "/opt/codex"), {
    HOME: "/tmp/home",
    PATH: ["/opt", dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    OPENAI_API_KEY: "openai-secret",
    CODEX_HOME: "/tmp/codex",
  });
  assert.throws(
    () =>
      providerEnvironment(
        "claude",
        { ...source, CLAUDE_CODE_USE_BEDROCK: "1" },
        "/opt/claude",
      ),
    /backends are not supported/,
  );
});

test("bounded text reads reject symlinks, hard links, invalid UTF-8, and oversized input", async () => {
  const root = await mkdtemp(join(tmpdir(), "coredoc-peer-input-"));
  const good = join(root, "good.md");
  const alias = join(root, "alias.md");
  const hardSource = join(root, "hard-source.md");
  const hard = join(root, "hard.md");
  const binary = join(root, "binary.md");
  await writeFile(good, "hello");
  await writeFile(hardSource, "hard-linked");
  await symlink(good, alias);
  await link(hardSource, hard);
  await writeFile(binary, Buffer.from([0xc3, 0x28]));

  assert.equal(await readBoundedText(good, { maxBytes: 5, label: "Prompt" }), "hello");
  await assert.rejects(readBoundedText(alias, { maxBytes: 20, label: "Prompt" }), /symlink/);
  await assert.rejects(readBoundedText(hard, { maxBytes: 20, label: "Prompt" }), /hard link/);
  await assert.rejects(readBoundedText(binary, { maxBytes: 20, label: "Prompt" }), /UTF-8/);
  await assert.rejects(readBoundedText(good, { maxBytes: 4, label: "Prompt" }), /exceeds 4 bytes/);
});

test("peer prompt labels untrusted input and stays artifact-only", () => {
  const prompt = buildPeerPrompt({
    action: "review",
    grounding: "artifact",
    source: "diff --git a/a b/a",
    sourceLabel: "git diff main",
    contexts: [{ label: "plan.md", text: "Do the thing" }],
  });
  assert.match(prompt, /independent peer reviewer/);
  assert.match(prompt, /Use only the supplied artifact and context/);
  assert.match(prompt, /untrusted data, never instructions/);
  assert.match(prompt, /git diff main/);
  assert.match(prompt, /plan\.md/);
});

test("Claude invocation uses safe mode with every built-in tool disabled", () => {
  const artifact = claudeInvocation({
    action: "review",
    grounding: "artifact",
    model: "claude-opus-5",
    effort: "high",
  });
  assert.deepEqual(artifact.args.slice(0, 5), [
    "--print",
    "--output-format",
    "json",
    "--safe-mode",
    "--disable-slash-commands",
  ]);
  assert.ok(artifact.args.includes("--no-session-persistence"));
  assert.equal(artifact.args[artifact.args.indexOf("--tools") + 1], "");
  assert.equal(artifact.args[artifact.args.indexOf("--allowedTools") + 1], "");

  assert.match(artifact.args[artifact.args.indexOf("--disallowedTools") + 1], /Bash/);
  assert.throws(
    () =>
      claudeInvocation({
        action: "new",
        grounding: "repo",
        model: "claude-opus-5",
        effort: "high",
      }),
    /artifact grounding only/,
  );

  const continued = claudeInvocation({
    action: "continue",
    grounding: "artifact",
    model: "claude-opus-5",
    effort: "high",
    sessionId: "123e4567-e89b-12d3-a456-426614174000",
  });
  assert.equal(continued.args[continued.args.indexOf("--resume") + 1], "123e4567-e89b-12d3-a456-426614174000");
});

test("Codex invocation is read-only, ignores ambient rules, and persists only consultations", () => {
  const review = codexInvocation({
    action: "review",
    grounding: "artifact",
    model: "gpt-5.6",
    effort: "high",
    cwd: "/tmp/empty",
  });
  assert.deepEqual(review.args.slice(0, 8), [
    "--ask-for-approval",
    "never",
    "--sandbox",
    "read-only",
    "--model",
    "gpt-5.6",
    "--cd",
    "/tmp/empty",
  ]);
  assert.ok(review.args.includes("--ephemeral"));
  assert.ok(review.args.includes("--ignore-user-config"));
  assert.ok(review.args.includes("--ignore-rules"));
  assert.ok(review.args.includes("--skip-git-repo-check"));
  assert.deepEqual(
    review.args.filter((value, index) => review.args[index - 1] === "--disable"),
    [
      "apps",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "computer_use",
      "image_generation",
      "in_app_browser",
      "multi_agent",
      "multi_agent_v2",
      "plugins",
      "skill_mcp_dependency_install",
      "skill_search",
      "shell_tool",
      "unified_exec",
    ],
  );

  const continued = codexInvocation({
    action: "continue",
    grounding: "artifact",
    model: "gpt-5.6",
    effort: "high",
    cwd: "/repo",
    sessionId: "123e4567-e89b-12d3-a456-426614174000",
  });
  const resume = continued.args.indexOf("resume");
  assert.equal(continued.args[resume + 1], "123e4567-e89b-12d3-a456-426614174000");
  assert.ok(!continued.args.includes("--ephemeral"));
  assert.throws(
    () =>
      codexInvocation({
        action: "new",
        grounding: "repo",
        model: "gpt-5.6",
        effort: "high",
        cwd: "/repo",
      }),
    /artifact grounding only/,
  );
});

test("provider output parsers fail on error envelopes and preserve resumable ids", () => {
  assert.deepEqual(
    parseClaudeOutput(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Looks good",
        session_id: "123e4567-e89b-12d3-a456-426614174000",
        total_cost_usd: 0.25,
      }),
    ),
    {
      answer: "Looks good",
      costUsd: 0.25,
      sessionId: "123e4567-e89b-12d3-a456-426614174000",
    },
  );
  assert.throws(
    () =>
      parseClaudeOutput(
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["model unavailable"],
        }),
      ),
    /reported an error: error_during_execution \| model unavailable/,
  );

  assert.deepEqual(
    parseCodexOutput(
      [
        JSON.stringify({ type: "thread.started", thread_id: "123e4567-e89b-12d3-a456-426614174000" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "One issue" } }),
      ].join("\n"),
    ),
    {
      answer: "One issue",
      sessionId: "123e4567-e89b-12d3-a456-426614174000",
    },
  );
  assert.throws(
    () => parseCodexOutput(JSON.stringify({ type: "error", message: "provider failed" })),
    /reported an error/,
  );
});

test("provider processes fail closed on output caps and timeouts", async () => {
  await assert.rejects(
    runProcess({
      command: "/bin/sh",
      args: ["-c", "printf 1234567890"],
      input: "",
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 1_000,
      maxOutputBytes: 5,
    }),
    /stdout exceeds 5 bytes/,
  );
  await assert.rejects(
    runProcess({
      command: "/bin/sh",
      args: ["-c", "sleep 10"],
      input: "",
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 25,
    }),
    /timed out/,
  );

  let processError;
  try {
    await runProcess({
      command: "/bin/sh",
      args: ["-c", "printf structured-error; exit 7"],
      input: "",
      cwd: tmpdir(),
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: 1_000,
    });
  } catch (error) {
    processError = error;
  }
  assert.equal(processError.message, "Provider exited 7");
  assert.equal(processError.providerStdout, "structured-error");
  assert.ok(!Object.keys(processError).includes("providerStdout"));

  const interrupted = runProcess({
    command: "/bin/sh",
    args: ["-c", "sleep 10"],
    input: "",
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 1_000,
  });
  setTimeout(() => process.emit("SIGTERM"), 25);
  await assert.rejects(interrupted, /interrupted by SIGTERM/);
});

test("provider diagnostics are bounded and scan secrets before truncation", () => {
  assert.equal(safeProviderDiagnostic("\u001b[31m model unavailable \u001b[0m"), "model unavailable");
  assert.equal(safeProviderDiagnostic("x".repeat(900)).length, 800);
  const credential = ["AKIA1234", "567890ABCDEF"].join("");
  assert.equal(safeProviderDiagnostic(`key = ${credential}`), undefined);
  assert.equal(safeProviderDiagnostic(`${"x".repeat(790)} key = ${credential}`), undefined);
  assert.equal(
    safeProviderDiagnostic("Authorization: Bearer Ab9Zx7Qp2Lm8Nv4Rs6Tu0Wy3"),
    undefined,
  );
});

test("egress and aggregate-size gates run before the provider executable", async () => {
  const bin = await mkdtemp(join(tmpdir(), "coredoc-peer-gate-bin-"));
  const repository = await mkdtemp(join(tmpdir(), "coredoc-peer-gate-repo-"));
  const provider = join(bin, "claude");
  const marker = join(bin, "provider-ran");
  const artifact = join(repository, "artifact.md");
  await writeFile(provider, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(provider, 0o755);
  const env = { PATH: bin, HOME: tmpdir(), COREDOC_HOME: join(repository, "state") };

  const high = ["AKIA1234", "567890ABCDEF"].join("");
  await writeFile(artifact, `credential = ${high}`);
  await assert.rejects(
    runBridge({
      provider: "claude",
      rawArgs: ["--action", "review", "--artifact", artifact, "--model", "claude-opus-5"],
      invocation: claudeInvocation,
      parseOutput: parseClaudeOutput,
      cwd: repository,
      env,
    }),
    /blocked credential content \(aws\.access_key\)/,
  );
  await assert.rejects(stat(marker), /ENOENT/);

  await writeFile(artifact, "Authorization: Bearer Ab9Zx7Qp2Lm8Nv4Rs6Tu0Wy3");
  await assert.rejects(
    runBridge({
      provider: "claude",
      rawArgs: ["--action", "review", "--artifact", artifact, "--model", "claude-opus-5"],
      invocation: claudeInvocation,
      parseOutput: parseClaudeOutput,
      cwd: repository,
      env,
    }),
    /blocked credential content \(auth\.bearer\)/,
  );
  await assert.rejects(stat(marker), /ENOENT/);

  await writeFile(artifact, "x".repeat(MAX_PROMPT_BYTES));
  await assert.rejects(
    runBridge({
      provider: "claude",
      rawArgs: ["--action", "review", "--artifact", artifact, "--model", "claude-opus-5"],
      invocation: claudeInvocation,
      parseOutput: parseClaudeOutput,
      cwd: repository,
      env,
    }),
    /Assembled peer prompt exceeds/,
  );
  await assert.rejects(stat(marker), /ENOENT/);
});

test("base reviews reject untracked coverage gaps before provider execution", async () => {
  const bin = await mkdtemp(join(tmpdir(), "coredoc-peer-untracked-bin-"));
  const repository = await mkdtemp(join(tmpdir(), "coredoc-peer-untracked-repo-"));
  const provider = join(bin, "claude");
  const marker = join(bin, "provider-ran");
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await writeFile(join(repository, "tracked.txt"), "tracked\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"],
    { cwd: repository },
  );
  await writeFile(join(repository, "tracked.txt"), "changed\n");
  await writeFile(join(repository, "untracked.txt"), "new\n");
  await writeFile(provider, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(provider, 0o755);

  await assert.rejects(
    runBridge({
      provider: "claude",
      rawArgs: ["--action", "review", "--base", "HEAD", "--model", "claude-opus-5"],
      invocation: claudeInvocation,
      parseOutput: parseClaudeOutput,
      cwd: repository,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: tmpdir(),
        COREDOC_HOME: join(repository, "state"),
      },
    }),
    /1 non-ignored untracked file/,
  );
  await assert.rejects(stat(marker), /ENOENT/);
});

test("base reviews never execute a repository-supplied git binary", async () => {
  const outside = await mkdtemp(join(tmpdir(), "coredoc-peer-trusted-bin-"));
  const repository = await mkdtemp(join(tmpdir(), "coredoc-peer-trusted-repo-"));
  const inside = join(repository, "bin");
  const marker = join(repository, "malicious-git-ran");
  await mkdir(inside);
  await execFileAsync("/usr/bin/git", ["init", "-q"], { cwd: repository });
  await writeFile(join(repository, "tracked.txt"), "tracked\n");
  await execFileAsync("/usr/bin/git", ["add", "tracked.txt"], { cwd: repository });
  await execFileAsync(
    "/usr/bin/git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"],
    { cwd: repository },
  );
  await writeFile(join(repository, "tracked.txt"), "changed\n");
  await writeFile(join(inside, "git"), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(join(inside, "git"), 0o755);
  await writeFile(join(outside, "claude"), "#!/bin/sh\nexit 1\n");
  await chmod(join(outside, "claude"), 0o755);

  await assert.rejects(
    runBridge({
      provider: "claude",
      rawArgs: ["--action", "review", "--base", "HEAD", "--model", "claude-opus-5"],
      invocation: claudeInvocation,
      parseOutput: parseClaudeOutput,
      cwd: repository,
      env: {
        PATH: `${inside}:/usr/bin:/bin:${outside}`,
        HOME: tmpdir(),
        COREDOC_HOME: join(repository, "state"),
      },
    }),
    /git executable resolves inside the repository/,
  );
  await assert.rejects(stat(marker), /ENOENT/);
});

test("sessions are repository-scoped and persist no prompts or responses", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "coredoc-peer-state-"));
  const repoA = await mkdtemp(join(tmpdir(), "coredoc-peer-repo-a-"));
  const repoB = await mkdtemp(join(tmpdir(), "coredoc-peer-repo-b-"));
  const env = { COREDOC_HOME: stateHome };
  const session = {
    provider: "claude",
    sessionId: "123e4567-e89b-12d3-a456-426614174000",
    sessionKey: "architecture",
    model: "claude-opus-5",
    effort: "high",
    grounding: "artifact",
  };

  await saveSession(repoA, env, session);
  assert.deepEqual((await loadSession(repoA, env, "claude", "architecture")).sessionId, session.sessionId);
  assert.equal(await loadSession(repoB, env, "claude", "architecture"), undefined);
  assert.notEqual(
    sessionFile(repoA, env, "claude", "architecture"),
    sessionFile(repoB, env, "claude", "architecture"),
  );
  const persisted = await readFile(sessionFile(repoA, env, "claude", "architecture"), "utf8");
  const metadata = await stat(sessionFile(repoA, env, "claude", "architecture"));
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.doesNotMatch(persisted, /prompt|response|Looks good/);
  await writeFile(sessionFile(repoA, env, "claude", "architecture"), "not-json");
  await assert.rejects(saveSession(repoA, env, session), /not valid JSON/);
  assert.equal((await resetSession(repoA, env, "claude", "architecture")).removed, true);
  assert.equal(await loadSession(repoA, env, "claude", "architecture"), undefined);
});

test("preflight validates flags in the subcommand scope where they are used", async () => {
  const bin = await mkdtemp(join(tmpdir(), "coredoc-peer-preflight-bin-"));
  const repository = await mkdtemp(join(tmpdir(), "coredoc-peer-preflight-repo-"));
  const provider = join(bin, "codex");
  await writeFile(
    provider,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "fake codex 1.0"; exit 0; fi',
      'if [ "$1" = "--help" ]; then echo "--ask-for-approval --cd --model --sandbox --ignore-user-config"; exit 0; fi',
      'if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then echo "--config --disable --ephemeral --ignore-rules --json --skip-git-repo-check --strict-config"; exit 0; fi',
      'if [ "$1" = "exec" ] && [ "$2" = "resume" ]; then echo "--config --disable --ignore-rules --ignore-user-config --json --skip-git-repo-check --strict-config"; exit 0; fi',
      "exit 1",
    ].join("\n"),
  );
  await chmod(provider, 0o755);
  await assert.rejects(
    checkProvider("codex", {
      cwd: repository,
      env: { PATH: bin, HOME: tmpdir() },
    }),
    /codex exec --help is missing required option\(s\): --ignore-user-config/,
  );
});

test("a valid paid answer survives non-zero exit and session persistence failure", async () => {
  const bin = await mkdtemp(join(tmpdir(), "coredoc-peer-answer-bin-"));
  const repository = await mkdtemp(join(tmpdir(), "coredoc-peer-answer-repo-"));
  const stateHome = await mkdtemp(join(tmpdir(), "coredoc-peer-answer-state-"));
  const provider = join(bin, "claude");
  const artifact = join(repository, "plan.md");
  const prompt = join(repository, "question.md");
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";
  const help = "--allowedTools --disable-slash-commands --disallowedTools --effort --model --no-session-persistence --output-format --permission-mode --print --resume --safe-mode --tools";
  const answer = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Paid answer",
    session_id: sessionId,
  });
  await writeFile(
    provider,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "fake claude 1.0"; exit 0; fi',
      `if [ "$1" = "--help" ]; then echo '${help}'; exit 0; fi`,
      `echo '${answer}'`,
      'if printf "%s" "$*" | grep -q -- "--no-session-persistence"; then exit 7; fi',
    ].join("\n"),
  );
  await chmod(provider, 0o755);
  await writeFile(artifact, "Review this bounded plan.");
  await writeFile(prompt, "Continue this consultation.");
  const env = { PATH: bin, HOME: tmpdir(), COREDOC_HOME: stateHome };

  const reviewed = await runBridge({
    provider: "claude",
    rawArgs: ["--action", "review", "--artifact", artifact, "--model", "claude-opus-5"],
    invocation: claudeInvocation,
    parseOutput: parseClaudeOutput,
    cwd: repository,
    env,
  });
  assert.equal(reviewed.answer, "Paid answer");
  assert.match(reviewed.providerWarning, /exited non-zero/);

  const pointer = sessionFile(repository, env, "claude", "architecture");
  await mkdir(dirname(pointer), { recursive: true });
  await writeFile(pointer, "not-json");
  const consulted = await runBridge({
    provider: "claude",
    rawArgs: [
      "--action",
      "new",
      "--session-key",
      "architecture",
      "--prompt",
      prompt,
      "--model",
      "claude-opus-5",
    ],
    invocation: claudeInvocation,
    parseOutput: parseClaudeOutput,
    cwd: repository,
    env,
  });
  assert.equal(consulted.answer, "Paid answer");
  assert.match(consulted.sessionWarning, /session pointer could not be saved/);
  assert.equal((await resetSession(repository, env, "claude", "architecture")).removed, true);
});

test("session turns are serialized by an atomic repository-scoped lock", async () => {
  const bin = await mkdtemp(join(tmpdir(), "coredoc-peer-lock-bin-"));
  const repository = await mkdtemp(join(tmpdir(), "coredoc-peer-lock-repo-"));
  const stateHome = await mkdtemp(join(tmpdir(), "coredoc-peer-lock-state-"));
  const provider = join(bin, "claude");
  const prompt = join(repository, "question.md");
  const startedMarker = join(bin, "provider-started");
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";
  const help = "--allowedTools --disable-slash-commands --disallowedTools --effort --model --no-session-persistence --output-format --permission-mode --print --resume --safe-mode --tools";
  await writeFile(
    provider,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "fake claude 1.0"; exit 0; fi',
      `if [ "$1" = "--help" ]; then echo '${help}'; exit 0; fi`,
      `printf started > ${JSON.stringify(startedMarker)}`,
      "sleep 0.25",
      `echo '${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Serialized answer",
        session_id: sessionId,
      })}'`,
    ].join("\n"),
  );
  await chmod(provider, 0o755);
  await writeFile(prompt, "Ask one bounded question.");
  const env = { PATH: bin, HOME: tmpdir(), COREDOC_HOME: stateHome };
  const args = [
    "--action",
    "new",
    "--session-key",
    "architecture",
    "--prompt",
    prompt,
    "--model",
    "claude-opus-5",
  ];
  const first = runBridge({
    provider: "claude",
    rawArgs: args,
    invocation: claudeInvocation,
    parseOutput: parseClaudeOutput,
    cwd: repository,
    env,
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await stat(startedMarker).then(() => true, () => false)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  await assert.rejects(
    runBridge({
      provider: "claude",
      rawArgs: args,
      invocation: claudeInvocation,
      parseOutput: parseClaudeOutput,
      cwd: repository,
      env,
    }),
    /already has an active claude turn/,
  );
  assert.equal((await first).answer, "Serialized answer");
});

test("bridge executes a pinned provider and resumes the stored session end to end", async () => {
  const bin = await mkdtemp(join(tmpdir(), "coredoc-peer-fake-bin-"));
  const repository = await mkdtemp(join(tmpdir(), "coredoc-peer-e2e-repo-"));
  const stateHome = await mkdtemp(join(tmpdir(), "coredoc-peer-e2e-state-"));
  const provider = join(bin, "claude");
  const artifact = join(repository, "plan.md");
  const prompt = join(repository, "question.md");
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";
  await writeFile(
    provider,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "fake claude 1.0"; exit 0; fi',
      [
        'if [ "$1" = "--help" ]; then echo',
        '"--allowedTools --disable-slash-commands --disallowedTools --effort --model --no-session-persistence --output-format --permission-mode --print --resume --safe-mode --tools";',
        "exit 0; fi",
      ].join(" "),
      `echo '${JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Independent answer",
        session_id: sessionId,
      })}'`,
    ].join("\n"),
  );
  await chmod(provider, 0o755);
  await writeFile(artifact, "Review this bounded plan.");
  await writeFile(prompt, "What edge case is missing?");
  const env = { PATH: bin, HOME: tmpdir(), COREDOC_HOME: stateHome };

  const review = await runBridge({
    provider: "claude",
    rawArgs: ["--action", "review", "--artifact", artifact, "--model", "claude-opus-5"],
    invocation: claudeInvocation,
    parseOutput: parseClaudeOutput,
    cwd: repository,
    env,
  });
  assert.equal(review.answer, "Independent answer");
  assert.equal(review.action, "review");

  const started = await runBridge({
    provider: "claude",
    rawArgs: [
      "--action",
      "new",
      "--session-key",
      "architecture",
      "--prompt",
      prompt,
      "--model",
      "claude-opus-5",
    ],
    invocation: claudeInvocation,
    parseOutput: parseClaudeOutput,
    cwd: repository,
    env,
  });
  assert.equal(started.session.exists, true);

  const continued = await runBridge({
    provider: "claude",
    rawArgs: [
      "--action",
      "continue",
      "--session-key",
      "architecture",
      "--prompt",
      prompt,
    ],
    invocation: claudeInvocation,
    parseOutput: parseClaudeOutput,
    cwd: repository,
    env,
  });
  assert.equal(continued.session.updatedAt >= started.session.updatedAt, true);
  assert.equal(
    (await loadSession(repository, env, "claude", "architecture")).sessionId,
    sessionId,
  );
});

test("Codex adapter executes through the same bounded bridge", async () => {
  const bin = await mkdtemp(join(tmpdir(), "coredoc-peer-fake-codex-bin-"));
  const repository = await mkdtemp(join(tmpdir(), "coredoc-peer-codex-repo-"));
  const provider = join(bin, "codex");
  const artifact = join(repository, "plan.md");
  await writeFile(
    provider,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "fake codex 1.0"; exit 0; fi',
      [
        'if printf "%s" "$*" | grep -q -- "--help"; then echo',
        '"--ask-for-approval --cd --config --disable --ephemeral --ignore-rules',
        '--ignore-user-config --json --model --sandbox --skip-git-repo-check --strict-config"; exit 0; fi',
      ].join(" "),
      `echo '${JSON.stringify({
        type: "thread.started",
        thread_id: "123e4567-e89b-12d3-a456-426614174000",
      })}'`,
      `echo '${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Codex answer" },
      })}'`,
    ].join("\n"),
  );
  await chmod(provider, 0o755);
  await writeFile(artifact, "Review this Codex input.");

  const review = await runBridge({
    provider: "codex",
    rawArgs: ["--action", "review", "--artifact", artifact, "--model", "gpt-5.6-sol"],
    invocation: codexInvocation,
    parseOutput: parseCodexOutput,
    cwd: repository,
    env: { PATH: bin, HOME: tmpdir(), COREDOC_HOME: join(repository, "state") },
  });
  assert.equal(review.answer, "Codex answer");
  assert.equal(review.action, "review");
});
