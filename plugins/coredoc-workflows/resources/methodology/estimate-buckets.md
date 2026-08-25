## Effort estimates

An estimate should live exactly as long as the decision it serves.

| Where | Estimate | Why |
|---|---|---|
| Options in a user-input question | **yes** — `human ~bucket / agent ~bucket` | changes which option is chosen and what the user does with the next hour |
| An implementation task, at dispatch time | **yes** — one bucket | answers "run this now or overnight" |
| An implementation task, written into the artifact | no | drifts; nobody remeasures it |
| A persisted specification section | no | per-component hour breakdowns manufacture precision that was never there |
| A `size` field in frontmatter | **yes** — `s` / `m` / `l` / `xl` | the durable, coarse form of the same signal |

### The scale

Use buckets, never hours. Precision beyond the bucket is invented, and the bucket
is what maps to a decision:

| Bucket | What the user does |
|---|---|
| `<5m` | waits |
| `5–30m` | picks up something small nearby |
| `30m–2h` | goes and does other work, checks back |
| `>2h` | schedules it, runs it overnight, or isolates it in a worktree |

Write `human ~30m–2h / agent ~5–30m`. Do not write `~3.5h`.

### What each number measures

**The same work, two executors.** `human` is how long a competent engineer would
need to do this task themselves. `agent` is the agent's wall-clock to do that
same task.

Do not silently redefine `human` as the user's supervision cost — the minutes
spent approving and reading the diff. That is a different quantity, it is almost
always small, and mixing it in makes the pair incomparable: the ratio stops
carrying any signal because the two halves no longer measure the same thing. If
supervision cost is worth stating, state it separately and label it.

### Why the pair, not one number

The two halves answer two different questions:

- **`agent` alone** — "how long am I waiting?" Drives whether the user waits,
  context-switches, or schedules it.
- **the ratio** — "is this worth delegating at all?"

Wide mechanical work is cheap for an agent and expensive for a human; a judgment
call is the reverse. A task reading `human ~2h / agent ~5–30m` should be
delegated by default, and that is visible from the pair alone.

### When the pair inverts

`agent >= human` is not a mistake to hide — it is the signal to surface. It means
**the user should do it by hand**: a two-line config edit, a one-word copy fix, a
rename in a single file. The agent's tool round-trips, file reads, and
verification cost more than the edit is worth, and the honest recommendation is
"faster if you just do it."

Say so in the option rather than burying it. A workflow that makes someone wait
twenty minutes for a ten-line change they could have made in two is the failure
this line exists to prevent, and the inverted pair is what makes it visible
before the waiting starts rather than after.

### Calibration

Agent wall-clock is measurable in a way human hours are not. Where the host
records per-stage duration, prefer the observed range for the task's class
(`recon`, `mechanical`, `hard`) over a guess, and say which it is. An estimate
that cites a measurement is subject to the same standard this plugin applies to
every other number: state how it was measured.
