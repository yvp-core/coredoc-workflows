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

This plugin executes bundled local scripts and platform-specific bundled native executables.
Release CI verifies their pinned SHA-256 digests. Cross-model adapters transmit
an explicitly approved artifact to the selected provider CLI; ordinary
workflows do not send repository content to Coredoc or another model.

Coredoc workflow capture is disabled by default. Plugin installation does not
start a process, enroll a user, create a credential, or change host settings.
The optional plugin-managed path activates only after an operator creates an
owner-readable `~/.coredoc/capture-agent-policy.json` and explicitly runs
capture setup on a supported macOS or Linux host. The policy is not a
secret, but it is a trusted routing boundary: schema 1 pins one HTTPS server
origin and workspace UUID; schema 2 pins a default destination and optional
destinations for listed checkouts. Only explicit loopback destinations may use
HTTP. The agent refuses policy drift.
Setup does not discover either value from a repository, Coredoc MCP, Coredoc
Desktop, host telemetry, or environment variables.

The installed agent copies the hash-verified relay and pinned Bun executable to
a stable, per-user directory and runs them through a per-user LaunchAgent or systemd user unit.
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

Question text is a separate, explicit exception: with
`COREDOC_CAPTURE_QUESTIONS=1`, answered Claude questions become bounded schema-4
events after Unicode normalization and catalog-based secret masking. This option
is off by default even when ordinary capture is enabled. Masking is best effort;
proprietary prose can remain, so enable it only for an appropriate destination.
Native telemetry continues to exclude prompts and tool payloads.

An advanced direct-cloud compatibility path is reachable only when an operator
explicitly supplies `COREDOC_CAPTURE_ENDPOINT` and an independent
`COREDOC_CAPTURE_HEADERS` credential; installation supplies neither value. It
does not reuse the plugin-managed agent credential. See
[the capture-agent security and lifecycle guide](docs/plugin-managed-capture-agent.md)
for migration, rollback, disable, and purge behavior.
