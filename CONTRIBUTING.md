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

Node.js 22 or newer is used only for the contributor/reference compatibility
test path. Installed plugins, including the optional capture agent, use the
pinned bundled Bun runtime and require no system JavaScript runtime.

## Capture-agent changes

Keep capture setup inert and opt-in. Tests must use an isolated home and a
fixture `~/.coredoc/capture-agent-policy.json`; never commit an organization's
server origin, workspace UUID, credential, home path, or deployment marker.
The policy fixture must use the production parser's exact three-field schema
and owner-only permissions.

When the installed capture runtime changes, update
`runtime/capture-agent-manifest.json` with the exact closed file set and
SHA-256 digests. Run the focused lifecycle/setup tests under bundled Bun, the
Node.js 22 compatibility suite, and the complete bundled-Bun suite. A lifecycle
change that touches launchd, runtime activation, or
rollback also needs an isolated macOS LaunchAgent smoke test before release;
Linux supervisor changes additionally need a real systemd user-manager smoke.
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

The normal suite checks every shipped skill's top-level Markdown fences and
UTF-8 size against `plugins/coredoc-workflows/test/skill-budgets.json`, including
the aggregate discovery catalog. These are byte budgets, not token estimates.
Ceilings round each skill up to the next KiB and keep at least 512 bytes of
headroom, so a wording fix never trips the gate but sustained growth does. Do
not automatically regenerate ceilings after a failure: explain any necessary
increase using the measured size the failing assertion reports, and for skills
that the routed scenarios reach, measure the behavior/cost of the change with
the workflow baseline harness. New skills need a measured budget; removed skills
must remove theirs.

## Pull requests

Explain the user-visible outcome, risk, validation performed, and any check that
could not be run. Do not include credentials, captured payloads, or unredacted
telemetry fixtures.
