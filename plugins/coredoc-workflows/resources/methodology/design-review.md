## Design review

Apply this when looking at rendered UI. It is a lens for judging what you see,
not a style guide to impose.

**The repository's own design source of truth wins.** When the project documents
its design system — a `DESIGN.md`, a token file, a component library — read it
first and treat it as authoritative. The rules below are defaults for a project
with no such document. Where they disagree with the project's documented system,
the project is right and the rule is noise: flagging a deliberate, documented
choice as a defect is how a design review loses its credibility in one pass.
Report a genuine conflict as a question, not as a finding.

### UX principles — how users actually behave

Observed behavior, not preferences.

1. **Don't make me think.** Every screen should be self-evident. If the user
   stops to ask "what do I click?" or "what does this mean?", the design failed.
   Self-evident beats self-explanatory beats requires-explanation.
2. **Clicks don't matter, thinking does.** Three mindless, unambiguous clicks
   beat one click that requires thought. Each step should feel like an obvious
   choice, not a puzzle.
3. **Omit, then omit again.** Cut half the words, then half of what is left.
   Self-congratulatory copy and instructions both need to die — if guidance has
   to be read to use the thing, the design failed.

How users actually behave:

- **They scan, they don't read.** Design for scanning: prominence equals
  importance, clearly defined areas, headings, highlighted key terms.
- **They satisfice.** They pick the first reasonable option, not the best one.
  Make the right choice the most visible choice.
- **They muddle through.** They wing it rather than figure out how it works, and
  once something works — however badly — they keep doing it that way.
- **They don't read instructions.** Guidance must be brief, timely, and
  unavoidable, or it will not be seen.

What that demands of the interface:

- **Use conventions.** Innovate on navigation only when you know you have a
  better idea; otherwise conventions are what let people orient instantly.
- **Visual hierarchy is everything.** Related things grouped, nested things
  contained, important things prominent. If everything shouts, nothing is heard.
  Start from the assumption that every element is noise until it earns its place.
- **Make clickable things obviously clickable.** Never rely on hover for
  discoverability — shape, position and formatting must signal it without
  interaction.
- **Eliminate noise by removal, not addition.** Its three sources are shouting,
  disorganization, and clutter.
- **Clarity beats consistency.** If a small inconsistency makes something much
  clearer, take the clarity.

**Navigation is wayfinding.** It must always answer: what is this, where am I,
what are the major sections, what are my options here. The trunk test: cover
everything except the navigation — you should still know what the product is and
where you are. If not, navigation failed.

**The goodwill reservoir.** Users start with goodwill and every friction point
drains it. Drained by: hiding what they came for, punishing them for not doing
things your way, asking for what you do not need, putting ceremony in their path,
and looking sloppy. Replenished by: making the obvious thing obvious, telling
them what they want to know up front, saving them steps, and making mistakes easy
to recover from.

### Hard rules

First classify the surface, because the rules differ:

- **Marketing / landing** — hero-driven, brand-forward, conversion-focused.
- **App UI** — workspace-driven, data-dense, task-focused: dashboards, settings,
  admin. Judge it on task completion and density, never on hero aesthetics.
- **Hybrid** — apply each rule set to the section it fits.

**Instant-fail patterns.** Flag any of these on sight:

- Generic SaaS card grid as the first impression
- A beautiful image with a weak brand
- A strong headline with no clear action
- Busy imagery behind text
- Sections repeating the same mood statement
- A carousel with no narrative purpose
- App UI assembled from stacked cards instead of a real layout

**Machine-generated tells.** These read as "an AI made this" and are worth
naming explicitly, because they are invisible to the person who produced them:

- Purple/violet/indigo gradient backgrounds, blue-to-purple schemes
- The three-column feature grid — icon in a colored circle, bold title, two-line
  description, repeated symmetrically. The single most recognizable tell.
- Icons in colored circles used as section decoration
- Centering everything
- The same large border-radius on every element
- Decorative blobs, floating circles, wavy dividers. A section that feels empty
  needs better content, not ornament.
- Emoji as design elements
- Colored left-border on cards
- Generic hero copy — "Welcome to X", "Unlock the power of", "Your all-in-one"
- Cookie-cutter section rhythm, every section the same height
- `system-ui` / `-apple-system` as the primary display face — unless the
  project's design system chose it deliberately, in which case this is not a
  finding at all

**Litmus checks.** Answer yes or no, and say which failed:

1. Is the product unmistakable in the first screen?
2. Is there one strong visual anchor?
3. Is the page understandable by scanning headlines alone?
4. Does each section have exactly one job?
5. Are the cards actually necessary?
6. Does motion improve hierarchy or atmosphere, or is it decoration?
7. Would it still feel premium with every decorative shadow removed?
