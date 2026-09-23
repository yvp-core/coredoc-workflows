# Hook fixture index

All `claude-*` and `codex-*` fixtures are REAL CLI captures (no env-relabelled fakes); the
`synthetic-*` files added later are documented in the last section. Both hosts were run from
scratch project dirs under this session's scratchpad, with project-level hook config
dumping raw stdin JSON to a `.jsonl` file via `dump-hook.sh` (`cat >> file; echo >> file`),
then one event per scenario was selected, redacted, and wrapped as
`{ provenance, redaction, payload }`.

Hosts: Claude Code `2.1.272`, Codex CLI `0.150.1` (model `gpt-5.6-luna` — the config-default
`gpt-6-astra` is rejected by this CLI build: `"The 'gpt-6-astra' model requires a newer
version of Codex"`).

Redaction applied uniformly: `session_id`/`turn_id` -> `11111111-1111-4111-8111-111111111111`,
workspace id `392b5f80-7345-495b-910c-1695b8b03a94` -> `00000000-0000-4000-8000-000000000000`,
`transcript_path` -> `/redacted/TRANSCRIPT_SENTINEL.jsonl`, `cwd` and every other absolute
path (anything under `/Users/`, `/private/`, `/tmp/`, `/Applications/`) -> `/redacted/PATH_SENTINEL`,
long string fields truncated to 600 chars with a `…[truncated]` marker. No emails/tokens/API
keys were found in any raw capture (checked before redaction). Field names, JSON types,
`tool_name`, `hook_event_name`, `tool_input` argument names/values (non-path), and the full
`tool_response` structure are preserved verbatim from the real payload.

## Setup

- `dump-hook.sh <target-file>` — appends raw stdin to `<target-file>`, one JSON blob per line.
- `claude-project/.claude/settings.json` — registers `PostToolUse`, `PostToolUseFailure`,
  `SessionStart`, `SessionEnd`, matcher `.*`, command = `dump-hook.sh .../claude-hooks.jsonl`.
- `claude-project/.mcp.json` — `coredoc-localserver` http MCP server (same URL as the repo's
  `.mcp.json`).
- `codex-project/.codex/hooks.json` — same four events/matcher, Claude-compatible schema,
  command = `dump-hook.sh .../codex-hooks.jsonl`. Confirmed this schema is genuine: the
  user's own `~/.codex/hooks.json` (untouched, not read for content beyond confirming shape)
  uses the identical `{"hooks": {"<Event>": [{"matcher", "hooks":[{"type":"command","command","timeout"}]}]}}` shape.
- Codex MCP server: **not added via `-c` override** — this machine's `~/.codex/config.toml`
  (untouched) already has `[mcp_servers.coredoc-localserver]` pointed at the same local URL
  with `enabled = true`, so codex-project runs picked it up with no project `.codex/config.toml`
  needed.
- Every `codex exec` used `--skip-git-repo-check --dangerously-bypass-hook-trust
  --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-luna` (the last two bypass the
  `approval_mode = "approve"` overrides the user config sets for several coredoc-localserver
  tools, which would otherwise block non-interactive exec).
- Every `claude -p` used `--settings <project settings.json> --mcp-config <project .mcp.json>
  --strict-mcp-config --allowedTools "<tool>" --permission-mode bypassPermissions`.

## Fixture list

| File | Command that produced it |
|---|---|
| `claude-2.1.272-session-start.json` | `claude -p "Call get_intent_context task='hook fixture probe' limit=3, then stop." --settings … --mcp-config … --strict-mcp-config --allowedTools mcp__coredoc-localserver__get_intent_context --permission-mode bypassPermissions` (SessionStart event from that run) |
| `claude-2.1.272-session-end.json` | same run (SessionEnd event) |
| `claude-2.1.272-mcp-get-intent-context-ok.json` | same run (PostToolUse for the MCP call) |
| `claude-2.1.272-mcp-get-intent-context-invalid-limit.json` | `claude -p "Call get_intent_context task='probe' limit=999, then stop." --allowedTools mcp__coredoc-localserver__get_intent_context …` |
| `claude-2.1.272-mcp-search-symbols-ok.json` | `claude -p "Call search_symbols query='finishWorkflowRun', then stop." --allowedTools mcp__coredoc-localserver__search_symbols …` |
| `claude-2.1.272-mcp-search-symbols-bad-scope-failure.json` | `claude -p "Call search_symbols scope='no-such-repo-xyz' query='anything', then stop." --allowedTools mcp__coredoc-localserver__search_symbols …` |
| `claude-2.1.272-grep.json` | `claude -p "Use Grep to search 'needle-pattern-for-grep-test' in sample.txt, then stop." --allowedTools Grep …` |
| `claude-2.1.272-glob.json` | `claude -p "Use Glob to list *.txt in cwd, then stop." --allowedTools Glob …` |
| `claude-2.1.272-read.json` | `claude -p "Use Read to read sample.txt, then stop." --allowedTools Read …` |
| `claude-2.1.272-bash-rg-version.json` | `claude -p "Use Bash to run: rg --version, then stop." --allowedTools "Bash(rg --version)" …` |
| `claude-2.1.272-bash-echo-pnpm-test.json` | `claude -p "Use Bash to run: echo pnpm test, then stop." --allowedTools "Bash(echo pnpm test)" …` |
| `claude-2.1.272-write.json` | `claude -p "Use Write to create written.txt with 'hello from write tool', then stop." --allowedTools Write …` |
| `claude-2.1.272-edit.json` | `claude -p "Read sample.txt, then Edit 'another line here' -> 'edited line here', then stop." --allowedTools "Read Edit" …` |
| `codex-0.150.1-session-start.json` | `codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox -m gpt-5.6-luna "Call get_intent_context task='hook fixture probe' limit=3, then stop."` (SessionStart) |
| `codex-0.150.1-session-end.json` | same run (SessionEnd) |
| `codex-0.150.1-mcp-get-intent-context-ok.json` | same run (PostToolUse for the MCP call) |
| `codex-0.150.1-mcp-get-intent-context-invalid-limit.json` | same prompt with `limit 999`, `"Do not retry or use any other tool if it fails."` appended |
| `codex-0.150.1-mcp-search-symbols-ok.json` | `... "Call search_symbols query='finishWorkflowRun', then stop."` (also captured an incidental `Bash` PostToolUse: codex read the `coredoc-mcp` plugin `SKILL.md` via `cat` before calling the tool) |
| `codex-0.150.1-grep.json` | `... "Search for the exact string needle-pattern-for-grep-test inside sample.txt (use whatever tool is idiomatic for you), then stop."` — codex ran `rg -n -F -- 'needle-pattern-for-grep-test' sample.txt` as a `Bash` tool call |
| `codex-0.150.1-glob.json` | `... "List files matching *.txt in the current directory..., then stop."` — ran via `Bash` (`ls`-family command) |
| `codex-0.150.1-read.json` | `... "Read the full contents of sample.txt..., then stop."` — ran via `Bash` (`cat`) |
| `codex-0.150.1-bash-rg-version.json` | `... "Run exactly this shell command and nothing else: rg --version, then stop."` |
| `codex-0.150.1-bash-echo-pnpm-test.json` | `... "Run exactly this shell command and nothing else: echo pnpm test, then stop."` |
| `codex-0.150.1-write.json` | `... "Create a file named written.txt ... containing exactly the text 'hello from write tool', then stop."` — codex used its `apply_patch` tool |
| `codex-0.150.1-edit.json` | `... "Edit sample.txt: replace 'another line here' with 'edited line here', ..., then stop."` — codex used `apply_patch` (after a `Bash cat` read, not included in this fixture) |
| `codex-0.150.1-bash-nonzero-exit.json` | bonus/extra: `... "Use the shell to run exactly this command: ls /no/such/path/at/all, then stop, do not retry..."` — shows a non-zero-exit shell command is still delivered as ordinary `PostToolUse`, not a failure hook |

No `codex-*-mcp-search-symbols-bad-scope-failure.json` fixture exists — see the Codex hard-failure
observation below; there is no tool-call hook payload to redact for that case.

## Envelope-shape observations

### Claude Code 2.1.272

- `hook_event_name` values actually seen: `SessionStart` (`source: "startup"`), `PostToolUse`,
  `PostToolUseFailure`, `SessionEnd` (`reason: "other"`). No other event names fired.
- MCP tool name spelling: `mcp__<server-name>__<tool-name>` verbatim, hyphens preserved
  (`mcp__coredoc-localserver__get_intent_context`).
- A **soft/business error** (the coredoc MCP tool itself returns `{"status":"error",...}` as
  JSON text, e.g. `get_intent_context` with `limit: 999` -> `invalid_page_limit`) arrives as an
  ordinary **`PostToolUse`** event. `tool_response` is an **array** of content blocks
  (`[{"type":"text","text":"<json-string>"}]`), and there is **no `isError` field anywhere** —
  status lives only inside the parsed JSON string in `text`.
- A **hard/protocol error** (`search_symbols` with an unknown `scope` — the MCP server throws
  rather than returning a normal tool result) arrives as **`PostToolUseFailure`**, which has a
  different shape than `PostToolUse`: no `tool_response` key at all; instead a top-level
  `"error"` string (the raw error message) and an `"is_interrupt": false` boolean. `tool_input`
  is still present and unchanged.
- Built-in tools (`Grep`, `Glob`, `Read`, `Bash`, `Write`, `Edit`) all fire as `PostToolUse` with
  their native `tool_name` capitalization; `tool_response` shape is tool-specific (e.g. `Write`'s
  is an object with `type`, `filePath`, `content`, `structuredPatch`, `originalFile`,
  `userModified`; `Bash`'s carries stdout/exit info — see the fixture for the exact keys).
  `ToolSearch` (the deferred-tool loader Claude uses before an MCP call) also fires its own
  `PostToolUse` and was captured incidentally in the raw jsonl but not turned into a fixture
  (not requested).
- Common envelope fields on every non-Session event: `session_id`, `transcript_path`, `cwd`,
  `prompt_id`, `permission_mode`, `effort.level`, `hook_event_name`, `tool_name`, `tool_input`,
  `tool_use_id`, plus `duration_ms` on `PostToolUse` (absent on `PostToolUseFailure`, which has
  `error`/`is_interrupt` instead).

### Codex CLI 0.150.1

- `hook_event_name` values actually seen: `SessionStart` (`source: "startup"`), `PostToolUse`,
  `SessionEnd` (`reason: "other"`), and (per the transcript log lines, not captured as a fixture
  since we never triggered it) `Stop`. **`PostToolUseFailure` was never observed to fire**, even
  when a tool call hard-failed (see below) — Codex's hooks.json schema accepts the event name
  (no validation error at load time) but this build appears not to emit it for tool calls, at
  least not for an MCP protocol-level error.
- MCP tool name spelling: **underscored**, not hyphenated —
  `mcp__coredoc_localserver__get_intent_context` / `mcp__coredoc_localserver__search_symbols`,
  even though the server is registered as `coredoc-localserver` (hyphen) in both `.mcp.json`/
  `config.toml`. Codex normalizes the server name's hyphen to underscore in the synthesized
  tool name; Claude does not.
- Shell commands are reported as **`tool_name: "Bash"`** (Claude-compatible naming, not
  `shell`/`exec_command`), with `tool_input: {"command": "<full shell string>"}` — same shape as
  Claude's Bash `tool_input`, but `tool_response` is a **plain string** (raw stdout/stderr
  combined), not an object with separate stdout/stderr/exit-code fields.
  There is **no dedicated Grep/Glob/Read tool** — Codex answers "search a string in a file",
  "list files matching *.txt", and "read a file's contents" by writing an ordinary shell
  command (`rg -n -F -- pattern file`, an `ls`/`find`-family listing, `cat`) that shows up as a
  `Bash` PostToolUse. There is no way to distinguish "this was a grep-shaped request" from the
  hook payload other than reading `tool_input.command`.
- File creation/edit is reported as **`tool_name: "apply_patch"`**, with `tool_input:
  {"command": "*** Begin Patch\n*** Add File: <path>\n+<content>\n*** End Patch"}` (a full
  patch-format string, not separate path/content fields) and `tool_response` a plain string
  status block (`"Exit code: 0\nWall time: ...\nOutput:\nSuccess. Updated the following
  files:\nA <path>\n"`).
- A **soft/business error** (`get_intent_context` with `limit: 999`) behaves exactly like
  Claude: ordinary `PostToolUse`, `tool_response` carries the JSON-with-`status:"error"` text,
  no `isError` flag. Shape differs from Claude only in the outer wrapper: Codex's
  `tool_response` is an **object `{"content": [...]}`** wrapping the same
  `[{"type":"text","text":...}]` content-block array Claude returns bare — i.e. Codex keeps the
  raw MCP JSON-RPC `result` object, Claude unwraps `.content` before handing it to the hook.
- A **hard/protocol error** (`search_symbols` with an unknown `scope`) is the sharpest
  cross-host difference found: **neither `PostToolUse` nor `PostToolUseFailure` fires at all**.
  The captured jsonl for that run contains only `SessionStart` and `SessionEnd` — the failed
  tool call is invisible to the hook system entirely, even though the transcript log clearly
  shows `mcp: coredoc-localserver/search_symbols (failed)` and the agent's own final message
  reports the failure. Reproduced twice (once per attempt) with identical results, so this is
  not a fluke. **Implication for the observer tests being fixture'd: on Codex, a hard MCP
  failure cannot be detected via PostToolUse/PostToolUseFailure hooks — only via the CLI's own
  stdout/exit behavior or (if available) reading back the session rollout file.**
- A **non-zero-exit shell command** (`ls /no/such/path/at/all`) is delivered as an ordinary
  `PostToolUse`, `tool_response` is the plain stderr string
  (`"ls: /no/such/path/at/all: No such file or directory\n"`) — consistent with Claude's
  Bash-failure-is-not-a-hook-failure behavior, and consistent with the general pattern that only
  MCP hard/protocol errors are candidates for `PostToolUseFailure` on either host (and on Codex,
  apparently not even those).
- Common envelope fields on every non-Session event: `session_id`, `turn_id` (Codex-specific,
  not present on Claude payloads), `transcript_path`, `cwd`, `hook_event_name`, `model`,
  `permission_mode`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id` (format
  `exec-<uuid>`, vs. Claude's `toolu_<random>`). No `duration_ms` field observed on Codex
  payloads (present on Claude's `PostToolUse`).

## Time-budget notes

Both hosts fired hooks on the first configuration attempt (project-level `.claude/settings.json`
via `--settings`, and project-level `.codex/hooks.json` via `--dangerously-bypass-hook-trust`) —
no host needed a second or third attempt, so the 3-attempt stop rule was never invoked. The one
real snag was Codex's config-default model (`gpt-6-astra`) being rejected by this CLI build
(400 `invalid_request_error`); switching to `-m gpt-5.6-luna` fixed it immediately.

## Synthetic fixtures (`synthetic-*.json`)

Added by issue 01 for the normalisation rows that have **no real producer to capture today**
(no cloud workspace refusal, no local overlay in a broken state, no handoff, no `isError`
transport on this machine). Each one is marked `provenance.capture:
"synthetic-from-server-source"` and names the server/MCP source file and lines its
`tool_response` text is derived from. The hook envelope around it is the real Claude Code
2.1.272 shape proven by the captures above (bare content-block array), except
`synthetic-mcp-is-error-envelope.json`, which uses the object wrapper because that is the only
shape an `isError` flag can travel on.

| File | Row it covers |
|---|---|
| `synthetic-cloud-intent-propose-created.json` | `intent_propose` → `ok`, `created: 1`, cited ref (observed for reporting; no gate reads it since implement dropped the candidates gate) |
| `synthetic-cloud-permission-denied.json` | cloud `status: permission_denied` → `denied` |
| `synthetic-cloud-not-configured.json` | cloud `status: not_configured` → `not_configured` |
| `synthetic-local-overlay-invalid.json` | local `overlayStatus: invalid` → `invalid` |
| `synthetic-local-overlay-not-configured.json` | local `overlayStatus: not_configured` → `not_configured` |
| `synthetic-cloud-intent-handoff-get.json` | `intent_handoff get` → read, `ok` |
| `synthetic-cloud-intent-handoff-list-empty.json` | `intent_handoff list`, empty `operations` → read, `ok` |
| `synthetic-cloud-intent-handoff-save.json` | `intent_handoff save` → write, `ok` |
| `synthetic-mcp-is-error-envelope.json` | `isError: true` → `error` |
