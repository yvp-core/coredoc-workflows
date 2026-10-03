---
name: coredoc-capture
description: Install, inspect, repair, upgrade, disable, or uninstall the Coredoc plugin-managed capture agent on macOS or Linux. Use for workflow or native telemetry setup and relay lifecycle requests.
---

# Plugin-managed capture agent

Resolve `<plugin-root>` as two directories above this file and run
`<plugin-root>/bin/coredoc-workflows capture <command>` by that full path.

The optional agent supports macOS Apple silicon and Linux x86_64 with glibc
and a running systemd user manager, runs on the plugin's bundled Bun, and needs
no system Node, Bun, or Python, and no Coredoc Desktop. It writes per-user
state below `~/.coredoc`, a per-user LaunchAgent or systemd unit, and
marker-owned global Claude Code/Codex settings, and never reads an MCP
credential store. Plugin-owned state uses
`ai.coredoc.workflows.capture-relay` and `~/.coredoc/capture-agent/capture-relay`;
the legacy Desktop label, plist, and `~/.coredoc/capture-relay` root are never
mutation targets.

`setup`, `repair`, `upgrade`, authenticated `doctor`, and `uninstall --purge`
need an operator-provisioned mode-0600 policy at
`~/.coredoc/capture-agent-policy.json` (or the same filename directly below an
explicit absolute `COREDOC_HOME`); local `status`, `disable`, and default
`uninstall` do not. Schema 1 holds one canonical HTTPS `serverOrigin` and one
RFC-4122 `workspaceId`. Schema 2 lists `destinations`: one `default` plus
optional ones that route their own absolute checkout paths (loopback
`http://127.0.0.1:<port>` is allowed there; `localhost` is not). Only the
operator supplies values: never install placeholders, infer them from a
repository, environment variable, or MCP, read credentials while checking the
file, or bypass a production discovery or cloud-probe failure by switching to
localhost or disabling HTTPS. `POLICY_INVALID` (malformed or unsafe file) and
`REPOSITORY_UNRESOLVED` (a listed checkout has no Git `origin`) fail before
enrollment; fix the policy and rerun. Never delete a repository-local
`.claude/settings.local.json` by hand; rerunning `setup` after the policy drops
its checkout removes it.

## Choose the smallest command

`status` (local) and `doctor` (adds a bounded authenticated cloud probe) are
read-only: use `status` first for a simple state question, and `doctor` when
capture is unhealthy or the user asks for diagnosis. Run the rest only on an
explicit request:

- `setup` installs or reconciles the agent and may open the browser for PKCE
  enrollment.
- `repair` repeats the marker-owned reconciliation and can restart an intact,
  verified runtime; explain the repair and get authorization for it first.
- `upgrade` activates the plugin's shipped runtime, without browser enrollment
  while the installation token stays valid.
- `disable` stops the service and removes host integration, keeping runtime,
  identity, credential configuration, and queues.
- `uninstall` also removes the runtime, keeping recoverable identity,
  credential configuration, and queues.
- `uninstall --purge` authenticates without minting a replacement token,
  quiesces capture, confirms revocation, and deletes retained local state and
  recognized queues. Never suggest it as cleanup; it needs a request to discard
  that state.

The setup paths are outside most repository sandboxes: request the host's
normal permission rather than changing `HOME`, `COREDOC_HOME`, or other paths
to evade the boundary. Never retry a failed mutating command automatically. On
failure, report the returned JSON's `code` and, when present, `rollback`,
without reading or printing installation or relay credential files. Then:

- `UNSAFE_STATE`: leave the untrusted runtime tree in place (no delete,
  overwrite, or purge), preserve credentials and queues, and escalate to the
  operator's recovery procedure.
- `INSTALLATION_REVOKE_UNCONFIRMED`: purge kept local recovery state and left
  capture disabled; the exact installation token's revocation is unconfirmed.
  A rejected retained bearer or another OAuth principal's empty token list is
  not proof of absence; do not bypass this check.
- `PURGE_INCOMPLETE`: cloud absence is confirmed; an explicit purge retry may
  finish local cleanup without another browser flow.
- For either purge code, claim no rollback. While `status` reports
  `purge: pending`, the only mutating command allowed is an explicitly
  authorized `uninstall --purge`.
- `UNINSTALL_INCOMPLETE`: host integration is removed, but the remote token and
  retained credentials are not revoked. Inspect `status`, then explicitly retry
  default uninstall or get `repair` authorized; never infer `--purge`.

Setup does not stop or migrate a Coredoc Desktop daemon or adopt state it does
not recognize. On `LEGACY_DESKTOP_PRESENT`, `OWNERSHIP_CONFLICT`,
`FOREIGN_LISTENER`, or a `CONFIG_CONFLICT` from leftover Desktop Codex OTEL or
claim-hook state, stop and follow the legacy cutover in
`<plugin-root>/README.md` (Delivery telemetry and privacy). Never inspect or
print credential-bearing settings, kill an unknown listener, or delete unproven
state.

After a successful first setup, tell the user to restart Claude Code and Codex
once. Codex may ask them to trust the installed `SessionStart` hook; declining
affects optional repository attribution, not immediate workspace-level native
delivery.
