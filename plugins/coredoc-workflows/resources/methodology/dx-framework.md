## Developer-experience framework

Apply this when the thing under review is consumed by developers — a CLI, an SDK,
an API, a plugin, a config surface. It is the lens for judging whether the
surface is pleasant to adopt, not whether the code behind it is correct.

### First principles

Every recommendation should trace back to one of these.

1. **Zero friction at T0.** The first five minutes decide everything. One command
   to start. Hello world without reading docs.
2. **Incremental steps.** Never require understanding the whole system before
   getting value from one part. A ramp, not a cliff.
3. **Learn by doing.** Working copy-paste examples in real context. Reference
   docs are necessary and never sufficient.
4. **Decide for me, let me override.** Opinionated defaults are a feature; escape
   hatches are a requirement.
5. **Fight uncertainty.** A developer needs to know what to do next, whether it
   worked, and how to fix it when it did not. Every error should carry problem,
   cause, and fix.
6. **Show code in context.** Hello world is a lie. Show real auth, real error
   handling, real deployment.
7. **Speed is a feature.** Iteration speed dominates: response times, build
   times, lines of code to accomplish a task, concepts to learn first.
8. **Create magical moments.** Find the one moment that feels like magic and make
   it the first thing a developer experiences.

### The seven characteristics

| # | Characteristic | What it means |
|---|---|---|
| 1 | Usable | Simple to install, set up, use. Intuitive surface, fast feedback. |
| 2 | Credible | Reliable, predictable, consistent. Clear deprecation. |
| 3 | Findable | Easy to discover, and easy to find help within. |
| 4 | Useful | Solves the real problem; features match actual use. |
| 5 | Valuable | Measurably reduces friction. Worth the dependency. |
| 6 | Accessible | Works across roles, environments, and preferences. |
| 7 | Desirable | Developers want to use it rather than tolerate it. |

### Cognitive patterns

Internalize these rather than enumerating them in a report.

- **Chef for chefs.** Your users build products for a living; they notice
  everything, so the bar is higher.
- **First five minutes.** Clock starts when they arrive. Can they reach a working
  result without docs, a sales call, or a signup?
- **Error-message empathy.** Every error is pain. Does it name the problem,
  explain the cause, and show the fix?
- **Escape-hatch awareness.** Every default needs an override. No escape hatch
  means no trust at scale.
- **Journey wholeness.** Discover → evaluate → install → hello world → integrate
  → debug → upgrade → scale. Every gap loses someone.
- **Context-switching cost.** Every time they leave the tool to find something,
  you lose them for ten to twenty minutes.
- **Upgrade fear.** Will this break production? Changelogs, migration notes and
  deprecation warnings make upgrades boring, which is the goal.
- **Completeness.** If developers write their own wrapper around your surface,
  the surface failed.
- **Pit of success.** Make the right thing easy and the wrong thing hard.
- **Progressive disclosure.** The simple case is production-ready, not a toy, and
  the complex case uses the same API.

### Scoring

| Score | Meaning |
|---|---|
| 9-10 | Best in class. Developers recommend it unprompted. |
| 7-8 | Good. Usable without frustration; minor gaps. |
| 5-6 | Acceptable. Works, with friction. Tolerated. |
| 3-4 | Poor. Developers complain; adoption suffers. |
| 1-2 | Broken. Abandoned after the first attempt. |
| 0 | Not addressed at all. |

**The gap method:** for each score, say what a 10 would look like *for this
product specifically*, then aim there. A score without that sentence is a number
nobody can act on.

**Time to hello world** is the single most predictive measure: under 2 minutes is
championship, 2-5 competitive, 5-10 needs work, over 10 loses most of the people
who tried. Measure it by actually doing it cold, not by reading the README and
estimating.

### Applying it honestly

The failure mode of a DX review is grading a surface you already know how to use.
Judge from the position of someone arriving without your context: what they must
install, what they must read, what error they hit first, and whether the tool
told them what to do about it.
