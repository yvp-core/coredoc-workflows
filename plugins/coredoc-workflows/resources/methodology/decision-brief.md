## Decision brief format

Every question you put to the user is a decision brief. Send it as a tool call,
not prose, whenever the host exposes a user-input tool.

**One decision per call, at most three options.** The structured tool is for
choosing among known alternatives; three is the portable ceiling across the hosts
this plugin runs on, so treat it as the cap rather than the ceiling of whichever
host you happen to be on. Two rules follow:

- **An open-ended question is not a decision brief.** If you are asking what the
  user wants rather than which of several known things they want, ask in prose.
  Manufacturing options to fit a question that has none produces a menu that
  excludes the real answer.
- **Never pack two decisions into one call.** If the answer to one changes the
  options for the other, they are two briefs in sequence, not one with more
  options.

```
D<N> — <one-line question title>
Context: <one short grounding sentence — the branch, file, or subsystem at stake>
ELI10: <plain English a 16-year-old could follow, 2-4 sentences, name the stakes>
Stakes if we pick wrong: <what breaks, what the user sees, what is lost>
Recommendation: <choice> because <one-line reason>
Completeness: A=X/10, B=Y/10   (or: Note: options differ in kind, not coverage)
Options:
A) <label> (recommended)   human ~bucket / agent ~bucket
  ✅ <pro — concrete, observable>
  ❌ <con — honest, not a strawman>
B) <label>                 human ~bucket / agent ~bucket
  ✅ <pro>
  ❌ <con>
Net: <one line on what is actually being traded off>
```

Number briefs `D1`, `D2`… within an invocation; increment yourself.

**ELI10 and Recommendation are always present.** Plain English, not function
names. Keep the `(recommended)` marker on exactly one option, including when the
posture is neutral — write `Recommendation: <default> — taste call, no strong
preference` rather than dropping the marker.

**Completeness** applies only when options differ in *coverage*: `10` complete,
`7` happy-path, `3` shortcut. When they differ in *kind* — two different
architectures, two different postures — write `Note: options differ in kind, not
coverage — no completeness score`. Never invent a score to fill the slot; a
filler number is worse than no number.

**Effort** goes on any option that carries it, as a bucket pair — see
`estimate-buckets.md` for the scale and for what each half measures. Never hours.

**Pros and cons must be concrete.** A con that no reasonable person would weigh
is a strawman and makes the brief dishonest. For a one-way or destructive choice
where an option genuinely has no downside, `✅ No cons — this is a hard-stop
choice` is the honest form.

### Four or more options — split, never drop

Three is the cap. With four or more real options, never drop, merge, or silently
defer one to make them fit — the option set is the user's, not yours to trim.
Either:

- **batch into groups of ≤3** when the alternatives are coherent variants, or
- **split into one call per option** when they are independent scope items.
  Default to this when unsure. Each call gets a `D<N>.k` label, its own ELI10 and
  recommendation, and three decision buckets: **Include / Defer / Cut**.

The user can stop a chain at any point by answering in prose instead of picking a
bucket. Treat that as a hold: stop firing the remaining calls immediately and
discuss, rather than queuing the rest and asking afterwards.

After a split chain, ask one final `D<N>.final` to confirm the assembled set,
since options chosen independently can conflict.

### When the tool is unavailable or a call fails

Do not silently auto-decide, and do not write the decision into an artifact as a
substitute. Retry a call that errored **once** — but only if no answer could have
reached the user already; a missing-result error can arrive after they saw the
question, and retrying would double-prompt.

If it is still unavailable, render the brief as **prose** and stop. Prose must
carry the same triad: the ELI10 of the decision itself, the per-option
completeness (or the kind-note), and the recommendation with its reason. Tell the
user to reply with a letter, then wait — their typed answer is the decision.

**A one-way door needs a stronger gate in prose than in the tool.** When the
decision is irreversible or destructive, require an explicit typed confirmation
of the option, state plainly what cannot be undone, and never proceed on a vague
or partial reply. Treat "ok" or "sure" without the explicit choice as
not-yet-confirmed and re-ask.

### Self-check before sending

- `D<N>` header, ELI10, and stakes line present
- Recommendation present, with a concrete reason
- Completeness scored, or the kind-note written
- Every option has at least one honest pro and one honest con
- `(recommended)` on exactly one option, neutral posture included
- Effort as a bucket pair on any option that carries effort
- `Net:` line closes the tradeoff
- Three options at most, and exactly one decision in this call
- Four or more options were split or batched — none dropped
- The question is a choice among known alternatives, not an open-ended ask
- You are calling the tool, not writing prose, unless it is genuinely unavailable
