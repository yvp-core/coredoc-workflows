# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/yvp-core/coredoc-workflows/security/advisories/new)
and include affected versions, reproduction steps, impact, and any suggested
mitigation.

The maintainers will acknowledge a complete report within seven days and will
coordinate disclosure after a fix or mitigation is available. Please avoid
accessing data that is not yours while validating a report.

## Supported versions

Security fixes are issued for the latest tagged release. Older `0.x` releases
may be asked to upgrade before a fix is backported.

## Trust boundary

This plugin executes bundled local scripts and two bundled native executables.
Release CI verifies their pinned SHA-256 digests. Cross-model adapters transmit
an explicitly approved artifact to the selected provider CLI; ordinary
workflows do not send repository content to Coredoc or another model.

Coredoc workflow capture is disabled by default. Plugin installation does not
start a process, enroll a user, create a credential, or change host settings.
The optional plugin-managed path activates only after an operator creates an
owner-readable `~/.coredoc/capture-agent-policy.json` and explicitly runs
capture setup on supported macOS. The policy is not a
secret, but it is a trusted routing boundary: it contains exactly one canonical
HTTPS server origin and one workspace UUID, and the agent refuses policy drift.
Setup does not discover either value from a repository, Coredoc MCP, Coredoc
Desktop, host telemetry, or environment variables.

The installed agent copies the hash-verified relay and pinned Bun executable to
a stable, per-user directory and runs them through a per-user LaunchAgent.
Secret-bearing state and
sanitized durable queues are owner-only; cloud authorization is stored only in
the relay configuration and is never copied into Claude Code or Codex settings.
The recorded Bun digest proves equality with the pinned upstream release; it is
not an Apple trust or enterprise application-control attestation. Rollouts under
MDM or allowlisting policy must validate that exact executable separately.
The local relay authenticates distinct host capabilities and reconstructs
native telemetry from a strict allowlist before persistence or network
delivery. Prompts, command and tool payloads, source, diffs, raw paths,
transcripts, and Git remote URLs are excluded. Marker-owned host edits are
merge-preserving, and unmanaged conflicts, unsafe files, unknown listeners, and
workspace drift fail closed. Ordinary engineering workflows remain fail-open if
capture is unavailable.

An advanced direct-cloud compatibility path is reachable only when an operator
explicitly supplies `COREDOC_CAPTURE_ENDPOINT` and an independent
`COREDOC_CAPTURE_HEADERS` credential; installation supplies neither value. It
does not reuse the plugin-managed agent credential. See
[the capture-agent security and lifecycle guide](docs/plugin-managed-capture-agent.md)
for migration, rollback, disable, and purge behavior.
