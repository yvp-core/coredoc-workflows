## Developer-experience framework

Apply this when the thing under review is consumed by developers — a CLI, an SDK,
an API, a plugin, a config surface. It is the lens for judging whether the
surface is pleasant to adopt, not whether the code behind it is correct. Judge it
as someone arriving without your context.

### Principles

Every recommendation should trace back to one of these.

1. **Zero friction at T0.** One command to start; a working result in the first
   five minutes without docs, a sales call, or a signup. Make the one magical
   moment the first thing a developer experiences.
2. **Progressive disclosure.** Value from one part without understanding the
   whole. The simple case is production-ready, not a toy, and the complex case
   uses the same API.
3. **Learn by doing, in context.** Working copy-paste examples with real auth,
   error handling, and deployment. Reference docs are necessary and never
   sufficient.
4. **Decide for me, let me override.** Opinionated defaults, and an escape hatch
   for every one.
5. **Fight uncertainty.** A developer knows what to do next and whether it
   worked. Every error names the problem, the cause, and the fix.
6. **Speed is a feature.** Response and build times, lines of code for a task,
   concepts to learn first, and every trip out of the tool to find something.
7. **The whole journey.** Discover → evaluate → install → hello world →
   integrate → debug → upgrade → scale; every gap loses someone. Changelogs,
   migration notes and deprecation warnings make upgrades boring.
8. **Pit of success.** The right thing is easy and the wrong thing hard. If
   developers write their own wrapper around the surface, it failed.

### Scoring

| Score | Meaning |
|---|---|
| 9-10 | Best in class; recommended unprompted. |
| 7-8 | Usable without frustration; minor gaps. |
| 5-6 | Works, with tolerated friction. |
| 3-4 | Developers complain; adoption suffers. |
| 1-2 | Abandoned after the first attempt. |
| 0 | Not addressed. |

**The gap method:** for each score, say what a 10 would look like *for this
product specifically*. A score without that sentence is a number nobody can act
on.

**Time to hello world** is the most predictive measure: under 2 minutes is
championship, 2-5 competitive, 5-10 needs work, over 10 loses most people who
try. Measure it cold, not by reading the README.
