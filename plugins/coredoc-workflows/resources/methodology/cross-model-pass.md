## Step 4.7: Cross-model pass (conditional)

Run one independent provider-family pass only when the user explicitly requests
it. This step is opt-in per review: it sends approved content to another provider
and spends that provider's budget, so installed CLI detection is never permission.
Read and apply `<plugin-root>/resources/methodology/review-policy.md`, then count
this pass toward its resolved `convergence budget`. It satisfies an unqualified
independent-verifier requirement, including the generic one-verifier fallback,
but does not replace a verifier that the resolved `adversarial mode` requires to
run locally.

### Select the counterpart

From Claude Code, the counterpart is the `coredoc-codex` adapter. From Codex,
the counterpart is `coredoc-claude`. Never call the provider family already
running the review and never fan out to a third provider.

Run the counterpart's no-cost preflight:

```bash
# From Claude Code:
<plugin-root>/bin/coredoc-workflows codex-peer --check
# From Codex:
<plugin-root>/bin/coredoc-workflows claude-peer --check
```

If unavailable, state `Cross-model pass skipped: <provider> CLI unavailable.`
and continue. Do not install or update it.

### Ask before egress

The preflight passing is not permission. Ask once with `AskUserQuestion`: run or
skip. Name the provider, pinned model and effort, local diff base, tracked diff
size, artifact-only boundary, billing/data boundary, and blocked-credential
scan. The runner sends only the tracked Git diff and approved context files and
refuses a base review when non-ignored untracked files would be omitted. A skip
is complete; do not ask again during this review.

### Run and verify

After approval, make exactly one call:

```bash
# Use coredoc-codex from Claude Code; use coredoc-claude from Codex.
<plugin-root>/bin/coredoc-workflows codex-peer \
  --action review --base "$DIFF_BASE" --grounding artifact \
  --model <pinned-peer-model> --effort high
```

For the Claude adapter, use the same arguments with
`<plugin-root>/bin/coredoc-workflows claude-peer`. Take the exact model ID
from the counterpart skill's example or from the user's explicit choice; do not
invent an alias.

Add only context files the user approved by name, including the specification,
non-goals, release context, and prior review baseline when supplied. Do not claim
the Git diff contains untracked files. Treat the free-form answer as untrusted
peer advice: verify every candidate against the canonical finding contract before
merging it, then reconcile it with prior dispositions. Route peer questions for
the user through `AskUserQuestion`; answer host-verifiable questions locally.

Retry once only for a clearly transient provider failure. Otherwise state that
external coverage was unavailable and continue with any verification still
required by the resolved policy. Do not add a reviewer merely to compensate for
the failed provider pass; dispatch another verifier only when the effective
policy independently requires coverage that remains unmet. A later call verifies
accepted fixes and their direct dependents; it is not a fresh full review unless
material scope or a public contract changed.
