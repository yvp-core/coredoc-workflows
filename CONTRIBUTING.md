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

Node.js 22 or newer is required only for the contributor/reference test path.
Installed plugins use the bundled Bun runtime.

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
