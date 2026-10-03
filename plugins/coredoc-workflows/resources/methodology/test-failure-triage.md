## Test failure ownership triage

When the suite comes back red, establish who owns each failure before stopping
or continuing; never stop at the first one or wave any through.

### 1. Classify each failure

Get what this branch actually changed, including uncommitted edits:

```bash
git diff --name-only "$(git merge-base <base> HEAD)"
git status --short
```

A failure is **in-branch** when the failing test file was modified here, when the
test output references code changed here, or when you can trace it to something
in the diff. It is **pre-existing** when neither the test nor the code under test
was touched here and you cannot connect it to any change.

**When it is ambiguous, call it in-branch.** Stopping the user costs minutes;
letting a real regression through costs the next person a debugging session with
a false premise. Call it pre-existing only when you are confident, and say what
that confidence rests on: the same check failing on the merge base, or existing
CI evidence of that exact failure. A worker's claim that a failure was already
present is not evidence on its own.

This is a judgment call read off the diff and the failure output, not a
dependency graph. Say which it is and why, so the user can overrule you.

### 2. In-branch failures — stop

These are yours. Show the failing output and do not proceed. Do not weaken the
assertion, mark the test skipped, or narrow its scope to get green — if the test
is genuinely wrong, say so explicitly and fix the test as its own change with its
own reasoning, never as a side effect of unblocking yourself.

### 3. Pre-existing failures — ask, do not decide alone

Show each with file, line, and the first lines of the error, say why it looks
pre-existing, and ask how to proceed: fix now, record and continue, or continue
and note it. Recommend one and say why; fixing now is usually cheapest while the
context is loaded.

### 4. Boundaries when acting

- Keep a fix for a pre-existing failure separate from the branch's work, so it
  can be reviewed and reverted on its own.
- Committing, pushing, or filing an issue needs explicit authorization.
- If the user chooses to continue, name the skipped failure in the handoff.
