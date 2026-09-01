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

The optional agent supports macOS with Node.js 22 or newer. Ordinary workflow
commands continue to use the plugin's bundled runtime. The agent writes only
per-user state below `~/.coredoc`, a per-user LaunchAgent, and marker-owned global Claude
Code/Codex settings. It must not create repository files, use Coredoc MCP for
routing or credentials, read an MCP credential store, or require Coredoc
Desktop.

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

If a version-managed Node executable was replaced or removed, install Node.js
22 or newer and run an explicitly authorized `repair`; restart Claude Code and
Codex if the executable location changed. `INSTALLATION_REVOKE_UNCONFIRMED`
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

If setup reports `MIGRATION_PENDING_UNSUPPORTED`, do not purge state or force
the migration. Let the recognized Coredoc Desktop relay drain the configured
workspace's legacy Codex queues, verify that they are empty, and then rerun
setup.

If setup reports `DESKTOP_RESTART_UNAVAILABLE`, it stopped before mutating the
Desktop service. Repair or reinstall that recognized Desktop relay so its
recorded executable and runtime script exist, verify it starts, and rerun
setup.

After a successful first setup, tell the user to restart Claude Code and Codex
once. Codex may ask them to trust the installed `SessionStart` hook; declining
affects optional repository attribution, not immediate workspace-level native
delivery. A production discovery or cloud-probe failure must not be bypassed by
switching the configured policy to localhost or disabling HTTPS.
