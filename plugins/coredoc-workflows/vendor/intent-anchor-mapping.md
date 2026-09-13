This dependency-free runtime is the compiled Coredoc core PR anchor wire parser.
It is bundled so users need neither the Coredoc CLI nor a local parser installation.
Canonical source: coredoc-parser/packages/core/src/intent/anchor-mapping.ts.
After a deliberate wire-contract change, build @coredoc/core, copy dist/intent/anchor-mapping.js
without its source-map directive, and update the SHA256 header. Run the producer command tests
and core/eval protocol fixtures together. This is a pinned generated artifact, not a second schema.
