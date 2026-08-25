## Test failure ownership triage

When the suite comes back red, do not stop on the first failure and do not wave
it through. Establish ownership first — the two wrong moves are blocking the user
on someone else's breakage, and shipping on a suite that was already red so the
next person cannot tell what your change did.

### 1. Classify each failure

Get what this branch actually changed:

```bash
git diff <base>...HEAD --name-only
```

A failure is **in-branch** when the failing test file was modified here, when the
test output references code changed here, or when you can trace it to something
in the diff. It is **pre-existing** when neither the test nor the code under test
was touched here and you cannot connect it to any change.

**When it is ambiguous, call it in-branch.** Stopping the user costs minutes;
letting a real regression through costs the next person a debugging session with
a false premise. Only call it pre-existing when you are confident.

This is a judgment call read off the diff and the failure output, not a
dependency graph. Say which it is and why, so the user can overrule you.

### 2. In-branch failures — stop

These are yours. Show the failing output and do not proceed. Do not weaken the
assertion, mark the test skipped, or narrow its scope to get green — if the test
is genuinely wrong, say so explicitly and fix the test as its own change with its
own reasoning, never as a side effect of unblocking yourself.

### 3. Pre-existing failures — ask, do not decide alone

Present the failures with file, line, and the first lines of the error, state
plainly that they look pre-existing and why, and ask how to proceed. Useful
options: fix now while the context is loaded, record and continue, or continue
and note it. Recommend one and say why — usually fixing now, since the context
is already loaded and it will be more expensive later.

To identify who most likely broke it, read **both** histories:

```bash
git log --format="%an (%ae)" -1 -- <failing-test-file>
git log --format="%an (%ae)" -1 -- <source-file-under-test>
```

When those differ, the production-code author is the likelier source of the
regression than the test author. This is read-only attribution to inform the
user, not an accusation to file anywhere.

### 4. Boundaries when acting

- Fixing a pre-existing failure is a **separate concern** from the branch's work.
  Keep it separable so it can be reviewed and reverted on its own.
- Committing, pushing, opening an issue, or assigning it to a person are
  outward-facing actions that need explicit authorization. Identifying the likely
  author is fine; filing something against them is not, unless the user asks.
- If the user chooses to continue, say so in the handoff: name the skipped
  failure. A green-looking report over a knowingly red suite is the report that
  makes every later report untrustworthy.
