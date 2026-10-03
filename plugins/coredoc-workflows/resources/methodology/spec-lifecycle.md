## Specification lifecycle

### Acceptance commands

The coordinator, not you, closes the specification stage with `stage-run finish
--stage-id spec --outcome success --spec-path <repo-relative path>`, or parks a
standalone delivery for up to 14 days with `finish-run --outcome delivered-draft
--spec-path <repo-relative path>`; tell it which artifact you wrote. The draft
carries `run: <runId>` back to a parked run. When approval arrives, usually in a
later session, do not edit `status:` by hand; run:

```text
<plugin-root>/bin/coredoc-workflows spec accept --path <repo-relative spec path>
<plugin-root>/bin/coredoc-workflows spec accept --finish
```

`spec accept --path` reopens the parked run and returns the intent instruction;
`--finish` then writes `status: accepted` itself. When `intent_propose` is
visible, propose and accept the verbatim items before running it; `--finish`
does not check for them. `--skip-intent "<reason>"` records a signed waiver of
the intent step. If the user drops the draft, run `spec abandon --reason
"<text>"`.

### Intent acceptance at approval

When the approved specification owns product intent of its own (no PRD) and
`intent_propose` is visible, run the "At document approval" write stage of
`<plugin-root>/resources/methodology/intent-context.md` and accept the verbatim
items under its single-approval clause, without asking again. A draft, or a
specification written from a PRD, proposes and accepts nothing.

### Privacy gate

When a Bash tool is available, run the privacy gate over the exact final file
before it is committed or filed anywhere:

```text
<plugin-root>/bin/coredoc-workflows redact-scan <spec-path>
```

Do not write on a HIGH finding. Never echo an unmasked finding. Without a Bash
tool, read the file once for credentials, tokens, connection strings, and
personal data, and say that the scan did not run.
