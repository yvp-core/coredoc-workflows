# Benchmark fixture rules

- Work only in this repository.
- Do not commit, publish, install dependencies, or access the network.
- Keep the change as small as the requested outcome permits.
- Put specifications in `.scratch/specs/` when a workflow requires one.
- Validate with `npm test` and `npm run validate:config` when relevant.
- Add or change tests only when existing tests do not provide evidence for changed observable
  behavior or a reachable regression.
