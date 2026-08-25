# Design review checklist

Apply only when the diff touches frontend source. Read each changed frontend file
in full, not only its diff hunk. If `DESIGN.md` or `design-system.md` exists, use
it as the primary calibration source.

## Evidence

- Source can prove structural violations such as overflow, missing semantics, or
  deviation from an explicit token.
- Visual-intent claims require browser evidence; otherwise classify them under
  the shared contract as HYPOTHESIS.

Apply the shared finding contract. A design preference without demonstrated
user-visible breakage is P3; the resolved Review policy determines whether any
severity blocks.

## Review areas

### Visual pattern risk

- Repeated generic hero or feature-grid patterns inconsistent with the product.
- Uniform decorative circles, gradients, or large border radii applied without
  hierarchy.
- Excessive centered layout or generic placeholder copy.

### Typography and structure

- Body text below the repository's accessible minimum.
- Broken heading hierarchy.
- New font families outside the documented design system.
- Text containers that allow unreadably long lines.

### Spacing and responsive layout

- Values outside a documented spacing scale.
- Fixed widths without responsive handling.
- Horizontal overflow at relevant viewports.
- New `!important` declarations masking specificity problems.

### Interaction and accessibility

- Missing hover, focus, disabled, loading, empty, or error states.
- Removed focus outlines without an equivalent visible indicator.
- Inadequate touch targets.
- Missing labels, keyboard reachability, focus management, or semantic roles.

### Design-system consistency

- Colors, typography, spacing, or component behavior outside explicit project
  conventions.

## Suppressions

Do not flag documented intentional choices, third-party styles, resets,
generated/minified CSS, or test fixtures. Report findings read-only using the
shared confidence and pre-emit verification gates.
