# Plugin-managed macOS capture agent

The `coredoc-workflows` plugin includes an optional per-user agent for native
Claude Code and Codex telemetry plus semantic workflow delivery. Marketplace
installation is inert: it does not enroll a user, start a process, create a
credential, enable OpenTelemetry, or change host settings. An operator must
provide one destination policy and explicitly run `capture setup`.

The agent is useful when capture should work across repositories and in
repository-less sessions without depending on Coredoc Desktop. It does not use
Coredoc MCP for setup, credentials, repository discovery, or routing. Ordinary
workflow skills remain independent of capture and continue to use the plugin's
bundled Bun runtime.

## Requirements

- macOS on a host supported by the plugin;
- a compatible Coredoc server with browser enrollment and capture-agent routes;
- one operator-selected HTTPS server origin and one workspace UUID;
- permission to write per-user state, global Claude Code/Codex configuration,
  and a per-user LaunchAgent.

The plugin ships a pinned Bun executable. Setup verifies its manifest digest and
copies Bun, its locked configuration, a small environment-sanitizing runner,
and the relay source into the same immutable version directory below
`~/.coredoc/capture-agent`. The LaunchAgent uses that installed copy rather than
the mutable plugin cache. The Codex claim hook follows the stable `current`
runtime link, so plugin cache rotation cannot strand the persistent agent.
No system Node, Bun, or Python installation is required.

Plugin ownership is isolated under the
`ai.coredoc.workflows.capture-relay` LaunchAgent label and
`~/.coredoc/capture-agent/capture-relay` state root. The legacy Desktop label,
plist, and `~/.coredoc/capture-relay` root are separate and are never plugin
mutation targets.

## Destination policy

Before `setup`, `repair`, `upgrade`, authenticated `doctor`, or destructive
`uninstall --purge`, create `~/.coredoc/capture-agent-policy.json`. When
`COREDOC_HOME` is set, it must be an absolute path and the policy uses the same
filename directly below that directory.

The JSON object must contain exactly these fields:

```json
{
  "schemaVersion": 1,
  "serverOrigin": "<https-origin>",
  "workspaceId": "<workspace-uuid>"
}
```

Replace both placeholders before setup. `serverOrigin` must be a canonical
HTTPS origin with no credentials, path, query, fragment, or trailing slash.
`workspaceId` must be an RFC-4122 version 4 UUID. Extra fields are rejected.

Schema 2 routes specific checkouts to their own server while every other
session keeps the default destination:

```json
{
  "schemaVersion": 2,
  "destinations": [
    { "id": "cloud", "serverOrigin": "<https-origin>", "workspaceId": "<workspace-uuid>", "default": true },
    {
      "id": "local",
      "serverOrigin": "http://127.0.0.1:3000",
      "workspaceId": "<local-workspace-uuid>",
      "repositories": ["/absolute/path/to/checkout"]
    }
  ]
}
```

Exactly one destination is `default` and it lists no repositories; every other
destination lists at least one absolute checkout path with a Git `origin`
remote, and a checkout belongs to one destination. `http:` origins are accepted
for `127.0.0.1` and `[::1]` only, never `localhost`, although such a server
may advertise its OAuth endpoints as `localhost` on the same port. Setup enrolls each
destination separately under the same installation id, writes the default
workspace bindings plus one repository binding per host per listed checkout,
installs a marker-owned `.claude/settings.local.json` in each listed checkout,
and probes every destination after health. Codex sessions are routed by their
`SessionStart` claim, repository binding first. Removing a checkout from the
policy and rerunning `setup` drops its bindings and its repository-local
settings. A schema-1 policy behaves exactly as before. See
`docs/plugin-capture-multi-destination-routing.md`.

Protect the directory and file before invoking setup:

```bash
chmod 700 ~/.coredoc
chmod 600 ~/.coredoc/capture-agent-policy.json
```

The file must be a regular, single-link file owned by the current user and must
not be group- or world-accessible. The policy is not a credential, but it is a
trusted routing boundary. The agent never infers or overrides it from a Git
remote, repository file, current directory, host event, environment-provided
endpoint, Coredoc MCP, or Desktop configuration.

One installation has one default workspace. Changing the default destination
beneath an existing installation returns `POLICY_DRIFT`; it never silently redirects
queued or live data. To deliberately move to another destination, keep the old
policy in place, explicitly purge the old installation, replace the policy,
then run a fresh setup.

## Commands

The supported executable contract is:

```text
coredoc-workflows capture setup
coredoc-workflows capture status
coredoc-workflows capture doctor
coredoc-workflows capture repair
coredoc-workflows capture upgrade
coredoc-workflows capture disable
coredoc-workflows capture uninstall
coredoc-workflows capture uninstall --purge
```

Marketplace installation does not put `coredoc-workflows` on `PATH`. The
installed `coredoc-capture` skill resolves the plugin root and invokes its
bundled launcher. From this source repository, use:

```bash
plugins/coredoc-workflows/bin/coredoc-workflows capture <command>
```

Every command emits one versioned, redacted JSON object. Failures return a
non-zero status and a stable error code; a mutating transaction also reports
whether rollback restored the previous state. Launcher-level failures that
happen before any script runs (unsupported platform, missing bundled runtime,
unknown command) are the exception: they print one plain-text line to stderr
and exit 69, 70, or 64 without a JSON envelope. Do not inspect or print
credential-bearing files to diagnose an error.

| Command | Behavior |
| --- | --- |
| `status` | Reads local ownership, runtime, host configuration, listener, and bounded queue state. It does not enroll, contact the server, or require the policy file. |
| `doctor` | Adds bounded policy and authenticated server checks to local status. It does not mutate state. |
| `setup` | Enrolls each configured destination if needed, installs and health-checks the immutable runtime, merge-writes marker-owned host settings (including repository-local Claude settings for listed checkouts), and probes every destination. Before enrollment or managed-state mutation, it returns `POLICY_INVALID` for a malformed policy, `REPOSITORY_UNRESOLVED` for a listed checkout without a Git origin, `LEGACY_DESKTOP_PRESENT` for the exact Desktop-v1 LaunchAgent, `OWNERSHIP_CONFLICT` for unrecognized state, or `FOREIGN_LISTENER` for an unowned listener. It is safe to rerun after conflicts are resolved and reports `destinations[]` (ids and counts only). |
| `repair` | Reconciles the same bounded marker-owned setup contract. It refuses unmanaged conflicts, unknown listeners, and unsafe installed state rather than deleting an untrusted runtime tree. |
| `upgrade` | Activates the runtime shipped by the current plugin with the existing installation credential and restores the prior runtime if activation fails. |
| `disable` | Stops the LaunchAgent and removes marker-owned host integration while retaining the runtime, identity, credential configuration, and queues. |
| `uninstall` | Also removes the marker-owned LaunchAgent and installed runtime, while retaining recoverable identity, credential configuration, and queues. |
| `uninstall --purge` | After explicit operator authorization and authenticated revocation, deletes the retained plugin-owned identity, credential configuration, and recognized queues. |

Run `status` before ordinary diagnosis. Mutating commands require explicit user
intent and may need host permission because their target paths are outside a
repository sandbox. Do not retry a failed mutating command automatically.

## Setup flow

`setup` is transactional and repository-independent:

1. Validate the user-owned destination policy and current local ownership.
2. Refuse unsafe files, an unknown process on the relay port, or unmanaged
   Claude Code/Codex OTLP configuration.
3. Reuse an owned installation when its credential passes the server probe, or
   open the browser for OAuth Authorization Code with PKCE enrollment.
4. Mint an installation-scoped telemetry credential for the configured
   workspace. OAuth access and refresh tokens are not persisted.
5. Copy the closed, hash-verified runtime into a digest-addressed directory
   below `~/.coredoc/capture-agent/runtime/versions`.
6. Point the stable `current` link at that runtime, install the per-user
   LaunchAgent, and prove authenticated local `/health/v2`. The relay also
   serves a binding-authenticated `GET /native-outbox/v1` diagnostic (pending
   count, pending bytes, and eviction counters for that binding); it is a
   local troubleshooting aid, not a stable contract for other tooling.
7. Merge marker-owned native OTLP settings into global Claude Code and Codex
   files. Unrelated settings are preserved.
8. Probe the configured server with the installation credential before
   committing the operation.

Restart Claude Code and Codex once after the first successful setup so both
hosts reload global settings. Codex may ask the user to trust the installed
`SessionStart` hook. Declining affects optional repository attribution, not
immediate workspace-level native delivery.

## Runtime and data layout

The default state root is `${COREDOC_HOME:-~/.coredoc}`:

```text
~/.coredoc/
  capture-agent-policy.json
  .capture-agent-purge.json  # present only while confirmed purge cleanup is pending
  capture-agent/
    installation.json
    state.json
    runtime/versions/<version>-<digest>/
    current -> runtime/versions/<version>-<digest>
    previous -> runtime/versions/<version>-<digest>
    capture-relay/
      relay.json
      codex-ingress.json
      codex-attribution-state.json
      codex-relay-events.jsonl
      codex-relay-events.jsonl.1
      native-outbox/
      outbox/
      artifact-outbox/
```

Secret-bearing files and queue records are mode 0600; containing directories
are owner-only. The LaunchAgent lives below `~/Library/LaunchAgents`. Installed
runtime files are immutable and verified against the plugin's closed manifest,
so the running process does not import from a repository checkout or plugin
cache.

Native Claude Code and Codex OTLP and semantic workflow events use separate
random local capabilities. The cloud bearer stays in
`capture-agent/capture-relay/relay.json`
and is not written to host settings. A missing physical repository does not
block native telemetry or workspace-level workflow events. Repository-bound
operations remain unavailable until the server resolves one unambiguous
normalized Git identity; the client does not create or guess a repository.

## Legacy Desktop cutover

Desktop is not a prerequisite, and the plugin does not automatically stop or
migrate a Desktop daemon, import its queues, or revoke its credentials. Before
enrollment or managed-state mutation, setup returns `LEGACY_DESKTOP_PRESENT`
for the exact standard Desktop-v1 LaunchAgent, `OWNERSHIP_CONFLICT` for
unrecognized state, or `FOREIGN_LISTENER` for an unowned listener on the relay
port. The plugin owns `ai.coredoc.workflows.capture-relay`; Desktop's standard
label remains `ai.coredoc.capture-relay`. Dormant development LaunchAgents with
a deterministic `ai.coredoc.capture-relay.<hash>` label are intentionally
outside distributed setup discovery.

Cut over the exceptional legacy machine manually. Let every binding drain, then
use Desktop's managed-capture **Disable** action for every configured Claude
repository and Codex profile and confirm every target is disabled. This removes
repository-local Claude settings that would otherwise override the plugin's
global settings. Any remaining Desktop Codex OTEL block or session-claim hook is
preserved, reported as legacy state, and blocks setup with `CONFIG_CONFLICT`;
the plugin never adopts or deletes it. Inventory every exact Desktop-marker standard and suffixed
development LaunchAgent, including dormant services, and stop and remove each
recognized service through its supported operator procedure. Atomically move
each corresponding `capture-relay` root—including `~/.coredoc/capture-relay`
and any configured development root—to a separate owner-only backup. Verify
that no old LaunchAgent, listener, or service that can reclaim the fixed relay
port remains before rerunning setup. The archived Desktop root is disjoint from
plugin-owned state. Never inspect or print credential-bearing settings, kill an
unknown listener, or delete state whose ownership is not proven. The plugin
neither imports nor deletes the backups. If an earlier pre-release plugin build
used the Desktop label or relay root, uninstall it with that same build before
running current setup; the current build intentionally refuses to adopt it.

Keep the backups through the rollback window. After the new agent is healthy and
that window closes, revoke the old Desktop telemetry credentials through the
ownership-scoped server or administrator workflow, verify their rejection, and
securely remove the backups.

For ordinary plugin-managed setup, any failure before the transaction commits
restores marker-owned host files, runtime links, and service state. A rollback
failure is reported explicitly instead of claiming setup succeeded.

## Upgrade, disable, rollback, and removal

`upgrade` stages the current plugin's runtime under a version-and-digest
directory, validates every file and import, switches the stable runtime links,
restarts the service, and checks `/health/v2`. Failed activation restores the
previous runtime and process. Host settings point at stable paths and do not
need to be rewritten for a runtime-only update.

`disable` is the reversible pause. It removes only marker-owned host integration
and stops the owned service while preserving the installation and pending data.
Running `setup` or an authorized `repair` can reconcile it later.

Default `uninstall` removes the marker-owned host integration, LaunchAgent, and
runtime, but intentionally retains identity, credential configuration, and
recognized pending queues for recovery. `uninstall --purge` is destructive: it
uses browser OAuth without minting or rotating another installation token,
quiesces the local agent, confirms revocation of the existing installation
credential, and then discards recognized queues, health state, artifact
quarantine, Codex attribution/journals, and local credentials. Use purge only
after explicitly deciding that pending telemetry and recovery state are no
longer needed. The operator-owned policy file is retained.

The OAuth principal's owned-token list is not treated as authoritative global
absence: another workspace member may have created the installation token, or
a token rotation may have committed before its response was lost. Rejection of
the retained local bearer cannot exclude a newer server token. A fresh purge
therefore proceeds only when the authorizing principal can see and revoke the
exact installation name. If it cannot, local recovery state is retained and
the command fails with `INSTALLATION_REVOKE_UNCONFIRMED`. Only a previously
written durable `revoked` receipt can resume local cleanup without that list.

After remote absence is confirmed, purge durably writes an owner-only,
mode-0600 `.capture-agent-purge.json` receipt containing only destination and
installation identifiers plus hashes of validated local artifacts. It contains
no bearer, ingress nonce, health secret, queue payload, or arbitrary path. Local
cleanup accepts each receipt-bound artifact only when it is exact or already
absent, validates the complete remainder before further deletion, and removes
the receipt last. Once that confirmed receipt exists, an explicit retry can
resume after process death or power loss without opening a browser, minting a
token, or repeating revocation. A process death in the narrow interval after a
server response but before the receipt is durable may require the same token
owner to authorize again. If authoritative absence is no longer visible, the
retry fails closed and retains recovery state; it never mints a replacement
token.
While the receipt exists, `status` reports `purge: pending` and `setup`,
`repair`, `upgrade`, `disable`, and default `uninstall` refuse with
`PURGE_INCOMPLETE`; only another explicit `uninstall --purge` resumes cleanup.

`INSTALLATION_REVOKE_UNCONFIRMED` means the server could not confirm whether an
attempted revoke committed. Host integration stays removed and the agent stays
disabled while local recovery state is retained; diagnose connectivity and
rerun purge explicitly. `PURGE_INCOMPLETE` means remote absence was confirmed
but a later local deletion failed. The agent likewise remains disabled, and a
subsequent explicit purge can finish local cleanup without minting a replacement
credential. Neither state reports a false rollback.

`UNINSTALL_INCOMPLETE` applies only to a non-purge uninstall whose lifecycle
cleanup could not be proven reversible. No remote token or retained credential
was revoked. Host integration remains removed so it cannot point at a stopped or
partially deleted runtime. Inspect `status`, then retry the default uninstall or
run an explicitly authorized `repair`; never infer `--purge` from this error.

## Security and privacy boundary

- Setup uses interactive browser PKCE only. It does not accept OAuth tokens on
  the command line or through environment variables.
- The long-lived installation credential has telemetry-write scope for the one
  policy workspace and is stored only in an owner-readable local file.
- The loopback relay authenticates host-specific local capabilities and replaces
  them with the cloud authorization only after validation.
- Native OTLP is reconstructed from an allowlist before any persistence or
  remote request. Prompts, tool or command arguments and results, source, diffs,
  transcript paths, raw current directories, Git remote URLs, account fields,
  and native cost estimates are excluded.
- Sanitized native, semantic, and artifact outboxes are separate, bounded,
  atomic, replay-safe, and owner-only.
- Health and command output contain only versions, hashes, counts, timestamps,
  closed states, and stable error codes—not credentials, payloads, or raw paths.
- Capture fails closed on identity, destination, credential, filesystem, and
  listener ambiguity. Ordinary workflow execution remains fail-open when
  capture is disabled or unavailable.

The independent direct-cloud compatibility path is not configured by agent
setup. It remains explicitly opt-in through `COREDOC_CAPTURE_ENDPOINT` and
`COREDOC_CAPTURE_HEADERS` and never reuses the plugin-managed credential.

## Release verification

Changes to the capture agent require focused setup, lifecycle, host
configuration, policy, and enrollment tests under bundled Bun, plus the Node.js
22 compatibility suite. Changes to runtime installation, launchd interaction,
or rollback also require an isolated macOS LaunchAgent smoke test. Tests must
use disposable homes and fixture policies; never test with a developer's live
profile, credential, relay, or pending queues.
