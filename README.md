# Coredoc Workflows

Open-source engineering workflows for Codex and Claude Code. The repository is
a single-plugin marketplace; the installable plugin lives in
`plugins/coredoc-workflows`.

The normal workflows work without Coredoc Desktop, the Coredoc MCP server,
Node.js, Bun, or npm installed on the user's machine. The plugin ships a pinned
macOS 13+ Apple-silicon Bun runtime and invokes only a closed set of bundled scripts.
Coredoc context is an optional enhancement: when it is unavailable, workflows
continue with repository-native search and explicitly report reduced coverage.

## Install

Add the marketplace without pinning a Git ref so marketplace upgrades can pick
up new plugin versions from the default branch.

### Codex

```bash
codex plugin marketplace add yvp-core/coredoc-workflows
codex plugin add coredoc-workflows@coredoc-workflows
```

### Claude Code

```bash
claude plugin marketplace add yvp-core/coredoc-workflows
claude plugin install coredoc-workflows@coredoc-workflows
```

Start a new task/session after installation. To test an unpublished checkout,
replace the GitHub source in the first command with this repository's absolute
path.

## Runtime and optional integrations

| Capability | Requirement |
| --- | --- |
| Core workflow, adaptive implementation, review, spec, explicit TDD, and repository QA | macOS 13 or later on Apple silicon |
| Browser QA | An installed Chrome-compatible browser |
| Claude/Codex peer review | The explicitly selected provider CLI |
| Coredoc graph context | An available Coredoc MCP server |
| Coredoc Desktop QA | An explicitly opted-in Coredoc development app |
| Plugin-managed workflow and native telemetry capture | macOS, system Node.js 22 or newer, a compatible Coredoc server, and an operator-provisioned `~/.coredoc/capture-agent-policy.json` |

Installing the plugin does **not** register a LaunchAgent, enable OpenTelemetry,
create a cloud credential, or change Claude Code or Codex settings. Capture is
an explicit, per-user setup step. It works without a repository, Coredoc MCP,
or Coredoc Desktop and is fixed to the one server origin and workspace UUID in
the mode-0600 user policy. Ordinary workflows continue to use the bundled Bun
runtime; only the optional persistent capture agent requires system Node.js 22
or newer. If that external Node installation is replaced, run `capture repair`
to rewrite the LaunchAgent and Codex hook before relying on capture again.

From a source checkout, an operator can inspect or enable it with:

```bash
plugins/coredoc-workflows/bin/coredoc-workflows capture status
plugins/coredoc-workflows/bin/coredoc-workflows capture setup
```

The installed `coredoc-capture` skill resolves the same executable without
requiring it on `PATH`. Setup may open a browser for enrollment, installs an
immutable runtime below `~/.coredoc/capture-agent`, and writes only marker-owned
global host configuration. See the
[capture-agent guide](docs/plugin-managed-capture-agent.md) for the exact policy,
migration, lifecycle, security, rollback, and uninstall contracts.

An advanced compatibility path can send workflow events directly when the
operator explicitly supplies `COREDOC_CAPTURE_ENDPOINT` and an independent
`COREDOC_CAPTURE_HEADERS` credential. Installation never creates or discovers
those values, and leaving the endpoint unset keeps capture disabled.

The plugin has no npm runtime dependencies and performs no runtime downloads.
The bundled executables, their hashes, and their upstream provenance are
committed with the plugin so an installation does not depend on a package
manager or network access.

## Development

```bash
npm test
npm run test:bun
npm run check:skills
npm run scan:secrets
claude plugin validate .
```

See the [plugin documentation](plugins/coredoc-workflows/README.md),
[contribution guide](CONTRIBUTING.md), [security policy](SECURITY.md), and
[release procedure](docs/releasing.md).

## License

Apache-2.0. Bundled third-party components retain their own licenses; see
[THIRD_PARTY_NOTICES.md](plugins/coredoc-workflows/THIRD_PARTY_NOTICES.md).
