# Reuse investigation evidence

Use this when a prior investigation already answers the same task and scope.
Read its report before adopting it. Save only a confirmed investigation, with
its reproducer, source locators, outcome and unresolved limits in a local file.
The command verifies provenance and revision identity, not report correctness.

After finishing the investigate stage successfully and before implementation:

```text
<plugin-root>/bin/coredoc-workflows investigation save --key <stable-task-key> --scope <scope-label> --report <local-report>
```

Repeat `--scope` for independent areas. Keep the task key and scope labels in the
handoff; they are local labels, not canonical server task IDs. Save snapshots all
repositories already registered with `track-repo`. The response gives a local
record path. The report body, paths, key and scope are never sent to capture.

To continue the same bug fix in a later workflow:

```text
<plugin-root>/bin/coredoc-workflows route-task --intent change --bug-like --reuse-investigation <record> --investigation-key <same-key> --investigation-scope <same-scope>
```

Repeat `--investigation-scope` for the original set. Routing checks the report
hash, primary checkout, every registered repository's HEAD and tracked/untracked
content before starting a run. A mismatch refuses reuse; investigate changed
areas and save fresh evidence. It never silently assumes that a different task
or expanded scope is covered. An unchanged snapshot cannot prove external
runtime state or ignored dependencies stayed current; refresh that evidence.

Successful reuse omits investigation from the new DAG and retains its source run
and report in local run-status. It does not replay completed-stage events, count
old MCP calls as new reads, or authorize implementation. Current intent and
implementation/review gates still apply. Cross-check newly relevant repositories
before reuse; an unregistered repository was never part of the saved evidence.
