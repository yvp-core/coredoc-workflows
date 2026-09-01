# Contributing

Thanks for improving Coredoc Workflows.

## Before opening a pull request

1. Keep changes focused and preserve fail-open behavior when optional Coredoc
   services are unavailable.
2. Add or update an ordinary regression test for observable behavior.
3. If a `SKILL.md.tmpl` or shared methodology file changes, run
   `npm run build:skills` and commit the generated `SKILL.md` files.
4. Run:

   ```bash
   npm test
   npm run test:bun
   npm run check:skills
   npm run scan:secrets
   claude plugin validate .
   git diff --check
   ```

Node.js 22 or newer is required for the contributor/reference test path and for
the optional plugin-managed capture agent. Installed plugins use the bundled
Bun runtime for ordinary workflows.

## Capture-agent changes

Keep capture setup inert and opt-in. Tests must use an isolated home and a
fixture `~/.coredoc/capture-agent-policy.json`; never commit an organization's
server origin, workspace UUID, credential, home path, or deployment marker.
The policy fixture must use the production parser's exact three-field schema
and owner-only permissions.

When the installed capture runtime changes, update
`runtime/capture-agent-manifest.json` with the exact closed file set and
SHA-256 digests. Run the focused Node.js 22 lifecycle/setup tests and the bundled
Bun suite. A lifecycle change that touches launchd, runtime activation, or
rollback also needs an isolated macOS LaunchAgent smoke test before release.
Do not use a live user profile, credential, relay, or queue as a test fixture.

## Runtime and binary changes

Do not replace a bundled executable without updating its provenance file,
license notice, byte size, SHA-256 digest, and the tests that verify them.
Runtime updates must use an official upstream release asset and record both the
archive digest and extracted-binary digest. Browser runtime updates must retain
the pinned upstream revision and clearly state whether the build is
reproducible.

## Generated files

Edit a skill's `SKILL.md.tmpl`, not its generated `SKILL.md`. Hand-written
skills have no template. The build script discovers this distinction from the
filesystem.

## Pull requests

Explain the user-visible outcome, risk, validation performed, and any check that
could not be run. Do not include credentials, captured payloads, or unredacted
telemetry fixtures.
