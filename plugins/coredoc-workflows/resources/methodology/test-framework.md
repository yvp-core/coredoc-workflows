## Test framework detection and bootstrap

### Detect the runtime and existing test system

Read repository instructions, package scripts, test configuration, and two or
three nearby tests before proposing anything. Capture the normal focused and
full-suite commands plus conventions for naming, imports, fixtures, assertions,
setup, teardown, and integration infrastructure. If multiple runtimes exist,
inspect the configuration of the package the task touches; the repository-root
runner may not govern every workspace.

### Existing framework

Use the established runner and conventions exactly, and add no other runner or
duplicate test configuration. Skip the bootstrap decision below.

### No framework detected

Report the evidence and constraint first. Adding dependencies, configuration,
example tests, CI, or documentation is an implementation change and requires
explicit user authorization.

If the runtime itself is unclear, ask for it. If the repository intentionally
does not use tests, record that as a current-run constraint; do not create a
repository marker or silently treat the absence as success.

When the user authorizes a bootstrap:

1. Research current framework guidance in official documentation for the
   detected runtime and framework version.
2. Present the smallest viable primary option and one credible alternative.
3. Explain package cost, unit/integration/E2E support, watch mode, TypeScript or
   transpilation implications, and compatibility with the existing CI/runtime.
4. For a monorepo, confirm which package is being bootstrapped before changing
   root configuration.

### Authorized bootstrap implementation

After the user selects an option:

1. Inspect dependency and lockfile consumers before editing shared root
   configuration.
2. Install only the selected minimum packages using the repository's package
   manager.
3. Add the smallest configuration and directory structure required.
4. Add at least one real test against existing behavior to prove the setup is
   connected to application code. Avoid existence-only assertions such as
   `toBeDefined()` or "does not throw."
5. Prefer recent, high-risk code: error handling, business rules with branches,
   API boundaries, then pure functions.
6. Run the focused test, then the normal suite or package-level suite.
7. If setup fails, diagnose once and preserve the partial diff for inspection.
   Never silently delete files, reset user changes, or rewrite lockfiles by hand.

Adding a CI workflow or a new testing guide is a separate decision unless the
user explicitly included delivery integration in the bootstrap request. Reuse an
existing CI provider and documentation location rather than creating parallel
conventions.

Do not commit automatically.
