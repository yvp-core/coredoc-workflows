# Workflow change baseline

This benchmark measures the current workflow cost before prompt or orchestration changes.
It deliberately separates two different numbers:

- **Static footprint:** UTF-8 bytes and whitespace-delimited words in the router and declared
  stage skills. These are deterministic size measures, not token estimates.
- **Live cost:** exact token usage reported by `codex exec --json`, plus wall-clock time for a
  model completing a change in a fresh copy of the synthetic fixture.

The scenarios cover new behavior, a bug fix, deletion of obsolete code, a
behavior-preserving refactor, a configuration/documentation update, and the pre-approval part
of a large shared-contract change. The large scenario intentionally stops at the workflow's
user-approval gate; it does not measure implementation or final review.

## Run

Static measurements do not call a model:

```bash
npm run baseline:workflows:static
```

A live baseline makes billable model calls. Three repetitions are the recommended minimum for
a directional baseline:

```bash
npm run baseline:workflows -- \
  --model gpt-5.6-sol \
  --effort low \
  --repetitions 3 \
  --workflow-ref HEAD \
  --output /tmp/coredoc-workflow-baseline.json
```

Use `--scenario deletion` (repeatable) for a pilot or a focused comparison. Run
`node scripts/workflow-change-baseline.mjs run --help` for all options.

By default the harness measures skill files in the working tree. Pass `--workflow-ref HEAD` (or
another Git revision) for a committed, reproducible baseline. The harness copies the selected
skill text into each temporary repository; it never modifies generated skills in the checkout.

The live harness ignores ambient Codex configuration and points the model at the workflow
skills in this checkout. It disables workflow capture and bookkeeping commands so that the
result measures reasoning and implementation work rather than an external telemetry system.
Each repetition uses a new temporary Git repository and deletes it afterward.

## Result privacy and interpretation

Committed result files are source-free. They contain scenario identifiers, routes, aggregate
usage, timing, validation status, and diff/test counts. They do not contain prompts, model
messages, command text, source, diffs, file paths, thread IDs, or raw JSONL. Raw Codex events
exist only in memory for the duration of a run.

Absolute input tokens include the Codex host prompt and should not be interpreted as “skill
tokens.” Compare the same model, effort, Codex version, fixture, and repetition count before
and after a workflow change. Prefer median and min/max over a single run. Run on an otherwise
quiet machine when comparing wall time.

The fixture is intentionally small. It is suitable for finding workflow overhead and obvious
route mistakes, not for predicting the cost of a production repository.

Keep live outputs outside the repository or upload them as CI artifacts. Date-stamped benchmark
results and optimization reports are intentionally not committed to the OSS tree.
