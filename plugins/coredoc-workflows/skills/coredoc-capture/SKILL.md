---
name: coredoc-capture
description: Install, inspect, repair, upgrade, disable, or uninstall the Coredoc plugin-managed macOS Coredoc capture agent. Use for workflow/native telemetry setup or relay lifecycle requests; do not use for ordinary workflow event recording.
---

# Plugin-managed capture agent

Resolve `<plugin-root>` as two directories above this file. The executable is:

```text
<plugin-root>/bin/coredoc-workflows capture <command>
```

This is the supported entry point for an installed plugin; do not assume the
executable is on `PATH`, and do not ask the user to locate a plugin cache.

The optional agent supports macOS on Apple silicon and uses the plugin's pinned
bundled Bun runtime. It does not require system Node, Bun, or Python. The agent writes only
per-user state below `~/.coredoc`, a per-user LaunchAgent, and marker-owned global Claude
Code/Codex settings. It must not create repository files, use Coredoc MCP for
routing or credentials, read an MCP credential store, or require Coredoc
Desktop. Plugin ownership uses `ai.coredoc.workflows.capture-relay` and
`~/.coredoc/capture-agent/capture-relay`; the legacy Desktop label, plist, and
`~/.coredoc/capture-relay` root are never mutation targets.

Before `setup`, `repair`, `upgrade`, authenticated `doctor`, or
`uninstall --purge`, require an operator-provisioned mode-0600 policy at
`~/.coredoc/capture-agent-policy.json` (or the same filename directly below an
explicit absolute `COREDOC_HOME`). It contains exactly `schemaVersion: 1`, one
canonical HTTPS `serverOrigin`, and one RFC-4122 `workspaceId`. Never install
placeholder values, infer them from a repository, environment variable, or
MCP, or read credentials while checking the file. A missing or changed policy
does not prevent local `status`, `disable`, or default `uninstall`.

## Choose the smallest command

- `status` is local and read-only. Use it first for a simple state question.
- `doctor` is read-only but includes a bounded authenticated cloud probe. Use
  it when capture is unhealthy or the user asks for diagnosis.
- `setup` installs or reconciles the agent and may open the browser for PKCE
  enrollment. Run it only when the user asks to enable or set up capture.
- `repair` repeats the bounded marker-owned reconciliation. Run it only after
  explaining the intended repair and receiving authorization for that repair.
- `upgrade` activates the runtime shipped by the installed plugin without
  browser enrollment when the current installation token remains valid. Run it
  only when the user asks to upgrade.
- `disable` removes marker-owned host integration and stops the service while
  retaining runtime, identity, credential configuration, and queues. Run it
  only when explicitly requested.
- `uninstall` removes marker-owned host integration, service, and runtime while
  preserving recoverable identity, credential configuration, and queues. Run
  it only when explicitly requested.
- `uninstall --purge` authenticates without minting a replacement token,
  quiesces capture, confirms revocation, and deletes retained local state and
  recognized queues. Never infer or suggest `--purge` as a routine cleanup;
  require an explicit request to discard that state.

Run the exact command through the host's normal command tool. The setup paths
are intentionally outside most repository sandboxes; request the normal host
permission when required rather than changing `HOME`, `COREDOC_HOME`, or other
paths to evade the boundary. Do not retry a failed mutating command
automatically. The executable returns one redacted JSON object and a non-zero
status on failure; report its stable `code` and rollback state without reading
or printing installation or relay credential files.

`repair` can reconcile marker-owned host configuration and restart an intact,
verified installed runtime. If a command reports `UNSAFE_STATE`, do not delete,
overwrite, or purge the untrusted runtime tree: preserve credentials and queues,
report the bounded code, and escalate to the operator's recovery procedure.
`INSTALLATION_REVOKE_UNCONFIRMED`
means purge retained local recovery state but intentionally left capture
disabled because the exact installation token was not authoritatively revoked.
A rejected retained bearer or an empty token list for a different OAuth
principal is not proof of absence; do not bypass this check. `PURGE_INCOMPLETE` means
cloud absence was confirmed and an explicit purge retry may finish receipt-bound
local cleanup without another browser flow. While `status` reports
`purge: pending`, do not run `setup`, `repair`, `upgrade`, `disable`, or default
`uninstall`; only rerun `uninstall --purge` after explicit authorization. Do not
claim either state rolled back, and do not read credential files to distinguish
them. `UNINSTALL_INCOMPLETE` is different: default uninstall did not revoke the
remote token or retained credentials, host integration remains removed, and the
safe next action is to inspect `status` and explicitly retry default uninstall
or authorize `repair`—never infer `--purge`.

Setup does not stop or migrate a Coredoc Desktop daemon, import its queues, or
revoke its credentials. `LEGACY_DESKTOP_PRESENT` identifies the exact Desktop-v1
LaunchAgent; `OWNERSHIP_CONFLICT` is unrecognized state, and
`FOREIGN_LISTENER` is an unowned process on the relay port. Stop on all three.
For the exceptional legacy machine, let every binding drain, use Desktop's
managed-capture **Disable** action for every configured Claude repository and
Codex profile, and confirm every target is disabled. This removes
repository-local Claude settings that override the plugin's global settings.
Any remaining Desktop Codex OTEL block or session-claim hook is legacy state:
setup returns `CONFIG_CONFLICT`, while `status`/`doctor` preserve it and report
the native or claim state as `legacy`. Stop and remove the recognized service.
The plugin recognizes only the standard
unsuffixed Desktop LaunchAgent; also inventory and retire every exact-marker
`ai.coredoc.capture-relay.<hash>.plist` development service, because a dormant
suffixed service is not auto-detected and can restart later. Move each recognized
Desktop `capture-relay` root—including the standard
`~/.coredoc/capture-relay` and any configured development root—to a separate
owner-only backup. Verify no old LaunchAgent, listener, or other
service that can reclaim the fixed relay port remains before rerunning setup.
The archived Desktop root is disjoint from plugin-owned state. Never inspect or
print credential-bearing settings, kill an unknown listener, or delete unproven
state. If an earlier pre-release plugin build used the Desktop label or relay
root, uninstall it with that same build before running current setup; the
current build intentionally reports `OWNERSHIP_CONFLICT` instead of adopting
or rewriting that old state. After the new agent is healthy and the rollback
window closes, revoke the old Desktop credentials through the ownership-scoped
server or administrator workflow, verify their rejection, and securely remove
the backups.

After a successful first setup, tell the user to restart Claude Code and Codex
once. Codex may ask them to trust the installed `SessionStart` hook; declining
affects optional repository attribution, not immediate workspace-level native
delivery. A production discovery or cloud-probe failure must not be bypassed by
switching the configured policy to localhost or disabling HTTPS.
