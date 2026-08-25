# Release procedure

Releases are immutable and use one SemVer value in the package plus both plugin
manifests.

1. Choose the next version and update:
   - `package.json` at the repository root;
   - `plugins/coredoc-workflows/package.json`;
   - both plugin manifests.
2. Regenerate skills and run every command in `CONTRIBUTING.md`.
3. Run `npm run verify:release -- vX.Y.Z`.
4. Review all runtime provenance, third-party notices, and the staged file list.
5. Merge the reviewed change, then create and push the matching annotated tag.

The tag workflow repeats validation, assembles a complete plugin ZIP, emits
`SHA256SUMS`, creates a build-provenance attestation, and publishes a GitHub
release. It does not download or replace bundled runtimes during release.
Downloaded assets can be verified side by side with
`shasum -a 256 -c SHA256SUMS`; the checksum file contains the archive basename,
not a build directory path.

The workflow intentionally refuses a tag that differs from the committed
version. A failed or partially published release is corrected with a new
version; published tags and assets are never replaced.
