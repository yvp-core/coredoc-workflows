This standalone runtime bundles the canonical Coredoc core PR anchor parser and
its CommonMark parser (`mdast-util-from-markdown`, MIT and its bundled dependencies).
Users need neither the Coredoc CLI nor a local parser installation.
Canonical source: coredoc-parser/packages/core/src/intent/anchor-mapping.ts.

Regenerate from the product repository:
`node scripts/sync-workflows-intent-parser.mjs ../coredoc-workflows`.
The bundle header records its SHA256. Run this plugin's producer tests and, from
coredoc-parser, the server cross-repo contract with COREDOC_WORKFLOWS_ROOT set to
this checkout. This exercises the methodology example through the actual command,
server delivery parser and connector normalizer. The vendor file is generated,
not a second schema; never patch it directly.
