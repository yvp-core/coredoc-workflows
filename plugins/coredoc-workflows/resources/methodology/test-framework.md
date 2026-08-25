## Test framework detection and bootstrap

### Detect the runtime and existing test system

Read repository instructions, package scripts, test configuration, and two or
three nearby tests before proposing anything. Capture the normal focused and
full-suite commands plus conventions for naming, imports, fixtures, assertions,
setup, teardown, and integration infrastructure.

Check at least:

```bash
setopt +o nomatch 2>/dev/null || true
[ -f Gemfile ] && echo "RUNTIME:ruby"
[ -f package.json ] && echo "RUNTIME:node"
[ -f requirements.txt ] || [ -f pyproject.toml ] && echo "RUNTIME:python"
[ -f go.mod ] && echo "RUNTIME:go"
[ -f Cargo.toml ] && echo "RUNTIME:rust"
[ -f composer.json ] && echo "RUNTIME:php"
[ -f mix.exs ] && echo "RUNTIME:elixir"
[ -f Gemfile ] && grep -q "rails" Gemfile 2>/dev/null && echo "FRAMEWORK:rails"
[ -f package.json ] && grep -q '"next"' package.json 2>/dev/null && echo "FRAMEWORK:nextjs"
ls jest.config.* vitest.config.* playwright.config.* cypress.config.* .rspec pytest.ini pyproject.toml phpunit.xml 2>/dev/null
ls -d test/ tests/ spec/ __tests__/ cypress/ e2e/ 2>/dev/null
```

If multiple runtimes exist, identify the package or application touched by the
task and inspect its local configuration. Do not assume the repository-root
runner governs every workspace.

### Existing framework

When a framework already exists:

1. Name it and locate its configuration.
2. Count or sample existing tests only with commands that exclude vendored
   dependencies and generated output.
3. Read two or three representative tests closest to the changed behavior.
4. Use the established runner and conventions exactly.
5. Do not add another runner, a parallel check system, generated specimens, or
   duplicate test configuration.

Skip the bootstrap decision below.

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

Use this only as a fallback starting point when current documentation is
unavailable:

| Runtime | Primary starting point | Alternative |
|---------|------------------------|-------------|
| Ruby/Rails | Minitest + fixtures + Capybara | RSpec + Factory Bot |
| Node.js | Vitest + Testing Library | Jest + Testing Library |
| Next.js | Vitest + Testing Library + Playwright | Jest + Cypress |
| Python | pytest + pytest-cov | unittest |
| Go | standard `testing` package | `testing` + Testify |
| Rust | `cargo test` | `cargo test` + a focused mocking crate |
| PHP | PHPUnit | Pest |
| Elixir | ExUnit | ExUnit + ExMachina |

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

### Regression-test quality

For every authorized bug fix, add a normal regression test when the behavior is
testable:

1. recreate the original precondition;
2. execute the actual failing path through the public or production-relevant
   boundary;
3. assert the corrected output or side effect;
4. cover the relevant error or alternate branch;
5. prove the test fails for the defect when feasible without preserving a frozen
   copy of the repository.

Mock external networks, clocks, randomness, or destructive services when needed
for determinism. Use real local database or integration infrastructure when
mocking would bypass the production contract and repository conventions support
it.
