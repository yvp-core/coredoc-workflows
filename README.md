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

Install the tagged `v0.11.0` release so the marketplace snapshot is immutable.

### Codex

```bash
codex plugin marketplace add yvp-core/coredoc-workflows --ref v0.11.0
codex plugin add coredoc-workflows@coredoc-workflows
```

### Claude Code

```bash
claude plugin marketplace add yvp-core/coredoc-workflows@v0.11.0
claude plugin install coredoc-workflows@coredoc-workflows
```

Start a new task/session after installation. To test an unpublished checkout,
replace the GitHub source in the first command with this repository's absolute
path.

## Runtime and optional integrations

| Capability | Requirement |
| --- | --- |
| Core workflow, review, spec, TDD, and repository QA | macOS 13 or later on Apple silicon |
| Browser QA | An installed Chrome-compatible browser |
| Claude/Codex peer review | The explicitly selected provider CLI |
| Coredoc graph context | An available Coredoc MCP server |
| Coredoc Desktop QA | An explicitly opted-in Coredoc development app |
| Managed workflow capture | Capture provisioned and enabled by Coredoc Desktop |

Installing the plugin does **not** register a relay, enable OpenTelemetry, or
create a cloud credential. Its session hook only checks a pre-existing,
Desktop-provisioned loopback relay when the managed capture environment is
already present. Otherwise it returns silently as unconfigured.

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
