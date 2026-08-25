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

Coredoc workflow capture is disabled by default. The supported managed path
activates only after Coredoc Desktop provisions the loopback relay and capture
environment. An advanced compatibility path is also reachable only when an
operator explicitly supplies `COREDOC_CAPTURE_ENDPOINT` and an independent
`COREDOC_CAPTURE_HEADERS` credential; installation supplies neither value.
