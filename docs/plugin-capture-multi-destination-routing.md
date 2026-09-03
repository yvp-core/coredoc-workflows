---
size: l
status: accepted
---

# Route capture per repository to more than one Coredoc server from one relay

> **Applicability to this repository.** This specification was written for the
> day.io fork, where the default destination is bundled with the plugin and a
> per-machine overlay adds loopback destinations. In `coredoc-workflows` the
> operator already provisions `~/.coredoc/capture-agent-policy.json`, so the
> same `destinations` list lives in that file as policy schema 2 and there is
> no overlay or bundled default. Read "overlay" below as "the schema-2 policy
> file"; everything about bindings, enrollment, routing, ownership, host
> settings, and rollback applies unchanged.


## Outcome and context

**Value:** The maintainer runs two Coredoc backends on one macOS machine: the day.io on-prem server (fixed workspace, HTTPS) and a local `coredoc-parser` development server on loopback HTTP. Today the plugin-managed capture agent can only forward to one `serverOrigin` and one `workspaceId`, so every agent session on the machine, including work inside the `coredoc-parser` repository, lands in the on-prem workspace, unattributed when the server does not know the repository. The desired outcome is one relay on `127.0.0.1:43181` that forwards sessions in explicitly listed repositories to the local server and everything else to on-prem, without a second agent, second port, or second host configuration. Why now: the Desktop relay is being removed from the pilot machine, so the plugin agent becomes the only local ingress and must serve both backends.

**Verified current state (day-ai-plugin, working tree on `codex/plugin-managed-capture-agent`):**

- Policy is one object with exactly `schemaVersion`, `serverOrigin`, `workspaceId`; `serverOrigin` must be a canonical HTTPS origin (`plugins/coredoc-workflows/scripts/capture-agent-policy.mjs:5-57`). The policy is bundled at `plugins/coredoc-workflows/runtime/capture-agent-policy.json` and currently points at the on-prem origin and one workspace.
- The relay config already carries the destination per binding: `nativeForwardEndpoint`, `captureForwardEndpoint`, `cloudAuthorization`, `workspaceId` (`managed-otel-relay.mjs:222-292`). Forward endpoints accept `https:` anywhere and `http:` only for `127.0.0.1` or `[::1]` (`managed-otel-relay.mjs:160-183`). The relay itself does not require HTTPS for loopback; only the policy loader does.
- Two binding kinds exist: `workspaceMode` (repo-less, one per host) and repository bindings keyed by `repositoryKey` and, for Codex, `repositoryScopeKey` (`managed-otel-relay.mjs:247-292`). Relay config validation forbids a Codex `workspaceMode` binding from coexisting with any other Codex binding (`managed-otel-relay.mjs:368-370`) and allows at most one `workspaceMode` binding per host (`:371-376`).
- Setup always writes exactly two `workspaceMode` bindings (Claude Code, Codex) for the single policy destination (`capture-agent-setup.mjs:buildRelayConfig`), and `ownedRelayConfig` requires exactly those two (`capture-agent-setup.mjs:444-455`).
- Claude Code native OTLP is routed by the `X-Coredoc-Relay-Binding` nonce header to the one Claude binding with that nonce (`managed-otel-relay.mjs:1905-1923`). The header is written once into `~/.claude/settings.json` (`host-global-config.mjs:19-35, 200-203`), so all Claude native records reach one binding. The design doc records that repository-local Claude settings override these global settings (`docs/plugin-managed-capture-agent.md`, UC-6).
- Codex native OTLP is grouped by `conversation.id` and routed by a session claim that maps `sessionId` plus `cwd` to a binding (`managed-otel-relay.mjs:2004-2116, 2155-2168`). When a Codex `workspaceMode` binding exists, every claim is assigned to it and repository bindings are never considered (`:2022-2038`).
- Semantic hook events choose a binding client-side: if exactly one `workspaceMode` binding exists for the host it always wins; repository bindings are consulted only when no workspace binding exists (`capture-client.mjs:106-140`). Repository identity comes from `resolveRepositoryIdentity` / `resolveRepositoryScopeKey` in `scripts/project-key.mjs:302-338`.
- Relay health treats more than one distinct `workspaceId` across bindings as `WORKSPACE_CONFLICT` and marks repository attribution `unavailable` (`managed-otel-relay.mjs:1615-1625`). Per-binding `/health` reports that binding's `workspaceId` (`:555, :1112`), which `capture-client.mjs:309` compares against the hook environment.
- Enrollment is per `serverOrigin`: OAuth discovery at `<origin>/.well-known/oauth-authorization-server`, then `PUT /api/v1/workspaces/:workspaceId/telemetry-token/installations/:installationId` (`capture-agent-enrollment.mjs:168, 314, 386-394`). Setup then probes `<origin>/api/v1/workspaces/:workspaceId/capture/v1/probe` (`capture-agent-setup.mjs:528`).
- The local server (`core-llm/coredoc-parser`, branch `feat/analytics-redesign`) listens on plain HTTP `PORT` 3000 (`apps/server/src/main.ts:151`), exposes `workspaces/:workspaceId/capture/v1` with `repositories/resolve`, `workspaces/:workspaceId/otel/v1/logs`, `workspaces/:workspaceId/telemetry-token/installations/:installationId`, and `.well-known` discovery. Its enrollment path is WorkOS AuthKit OAuth per `apps/server/.env.example:18-26`. A `capture/v1/probe` route was not found on that branch.

**Release context:** Only the maintainer pilot needs a second destination; the fleet keeps the bundled single on-prem destination. The current release explicitly lists "Multiple workspaces or runtime workspace selection" as not included, so this is a follow-up release after the Desktop cutover, not a change to the cutover branch.

## Intent model

### Use cases and flows

| ID | Actor / trigger | Preconditions | Success outcome | Alternate / failure |
| --- | --- | --- | --- | --- |
| UC-1 | Maintainer runs `capture setup` with a policy that names a default destination plus a local loopback destination scoped to listed repositories | Both servers reachable; no legacy relay state (existing preflight) | One relay on 43181; on-prem gets its two workspace bindings; the local destination gets one repository binding per host per listed repository; each destination enrolled with its own installation token | Any destination fails enrollment or probe: whole setup rolls back as today (`ROLLBACK_FAILED` / `rollback: "restored"`); nothing partially routed |
| UC-2 | Agent session (Claude Code or Codex) starts inside a listed repository (for example `coredoc-parser`) | UC-1 done; repository identity resolvable from `cwd` | Hook events, and native OTLP for that session, reach the local server's workspace; nothing from that session reaches on-prem | Repository identity unresolvable (no git remote): session falls to the default destination as repo-less capture, same as today |
| UC-3 | Agent session starts in any other directory (day.io repositories, non-repositories) | UC-1 done | Behaviour identical to the current fixed-workspace release: on-prem receives the session | — |
| UC-4 | Fleet developer installs the plugin with the bundled single-destination policy | No local overlay present | Relay config, health, and `ownedRelayConfig` are byte-for-byte what the current release produces; no new files, prompts, or codes | — |
| UC-5 | Maintainer runs `status`, `doctor`, `upgrade`, `disable`, `uninstall` on a multi-destination install | UC-1 done | Every command recognises the plugin-owned config as owned and reports each destination separately | Config does not match the set implied by the active policy: `OWNERSHIP_CONFLICT`, unchanged from today |

### Business rules

| ID | Condition | Required outcome | Source / owner | Observer |
| --- | --- | --- | --- | --- |
| BR-1 | A session's repository identity matches a listed repository of a non-default destination | That destination's binding receives the session's hook events and native records; the default binding receives none of them | Requested outcome; relay routing at `managed-otel-relay.mjs:2004-2116` and `capture-client.mjs:106-140` reversed to repository-first | UC-2, AC-1, AC-2 |
| BR-2 | No listed repository matches, or identity is unresolvable | The default destination's `workspaceMode` binding receives the session exactly as the current release does | Current behaviour (`managed-otel-relay.mjs:1360-1383`) preserved | UC-3, AC-3 |
| BR-3 | A destination's `serverOrigin` uses `http:` | Accepted only when the host is `127.0.0.1` or `[::1]`; any other `http:` origin is rejected at policy load | Mirrors the relay's existing loopback exception (`managed-otel-relay.mjs:167-171`) | UC-1, AC-5 |
| BR-4 | The policy declares more than one destination | Exactly one destination is marked default; every non-default destination lists at least one repository; two destinations never share a repository key | Needed so BR-1/BR-2 are deterministic | UC-1, AC-5 |
| BR-5 | The bundled policy is the only policy present | Setup output is identical to the current release (two workspace bindings, one workspace hash in health) | Fleet compatibility | UC-4, AC-4 |
| BR-6 | Bindings span more than one `workspaceId` because the policy declares more than one destination | Health does not report `WORKSPACE_CONFLICT`; repository attribution stays `ready`; each binding's `/health` still reports its own `workspaceId` | Change to `managed-otel-relay.mjs:1615-1625`; per-binding health at `:555, :1112` unchanged | UC-5, AC-6 |
| BR-7 | `ownedRelayConfig` is evaluated | The expected binding set is derived from the active policy (two workspace bindings for the default plus one repository binding per host per listed repository), not the literal count two | Replaces `capture-agent-setup.mjs:444-455` | UC-5, AC-4, AC-6 |
| BR-8 | Setup enrolls a destination | Each destination gets its own OAuth enrollment and installation token under the same `installationId`; a token for one origin is never sent to another | Existing per-origin enrollment (`capture-agent-enrollment.mjs:168-394`); relay already stores `cloudAuthorization` per binding | UC-1, AC-7 |

### Limitations

| ID | Constraint | Reason | Affected flow |
| --- | --- | --- | --- |
| LIM-1 | Claude Code emits native OTLP to one global endpoint with one global header set and no `cwd` | Claude Code configuration model (`host-global-config.mjs:19-35`); relay routes Claude native records by header nonce only (`managed-otel-relay.mjs:1905-1923`) | UC-2 native records for Claude Code need a per-repository override or a claim mechanism (ADR-2) |
| LIM-2 | Codex config validation forbids a `workspaceMode` Codex binding alongside repository Codex bindings, and claims always pick the workspace binding | `managed-otel-relay.mjs:368-370, 2022-2038` | UC-2 for Codex requires relaxing both |
| LIM-3 | The local server's enrollment is WorkOS AuthKit OAuth; a local dev server without WorkOS cannot complete browser enrollment | `coredoc-parser/apps/server/.env.example:18-26` | UC-1 local destination (unresolved decision 1) |
| LIM-4 | Setup's post-enrollment probe calls `capture/v1/probe`; that route was not found on the local server branch inspected | `capture-agent-setup.mjs:528` vs `coredoc-parser/apps/server/src/modules/capture/capture.controller.ts` | UC-1 local destination; verify or make the probe per-destination optional |
| LIM-5 | Relay loopback exception accepts `127.0.0.1` and `[::1]` only, not `localhost` | `managed-otel-relay.mjs:167-168` | Policy must use `http://127.0.0.1:3000` |
| LIM-6 | A machine-specific loopback destination cannot live in the bundled fleet policy | The policy file ships inside the plugin | UC-1 needs a per-machine overlay (ADR-1) |

## Scope

**In:** policy schema v2 with a `destinations` list and loopback-HTTP exception; per-machine policy overlay for non-default destinations; setup builds default workspace bindings plus repository bindings per listed repository and enrolls each destination; repository-first selection in the hook client and in Codex claims; relay config validation and health adjusted for one workspace binding plus repository bindings per host across multiple workspaces; `ownedRelayConfig` derives its expected set from the policy; Claude Code per-repository routing via the mechanism chosen in ADR-2; docs and skill updated with the new policy shape and the codes it can emit.

**Non-goals:** a second agent, port, LaunchAgent label, or state root (rejected: one host OTEL endpoint means native data could only reach one of them); runtime workspace selection or a UI to switch destinations; automatic discovery of repositories to route (listing is explicit); fan-out of one session to two destinations (each session has exactly one destination); changing the on-prem server; changes to the Desktop cutover branch or its fail-closed preflight; Linux or Windows.

**Contracts/consumers:** `runtime/capture-agent-policy.json` (schema bump to 2, v1 still accepted); relay config schema stays 1 because the binding shape is unchanged; CLI JSON `schemaVersion` stays 1 with a new `destinations[]` array in `setup`, `status`, `doctor` output alongside the existing fields; `coredoc-capture` skill and README document the overlay and the new failure codes; `ensure-managed-relay` SessionStart hook and `workflow-observer` consume the client selection change transparently; server routes are unchanged.

## Acceptance

| ID | Pass/fail outcome | Observer / validation | Traces to |
| --- | --- | --- | --- |
| AC-1 | A Codex session claimed from a listed repository's `cwd` forwards its buffered and subsequent native records only to that repository binding's endpoint; the default binding's endpoint sees zero records from that session | Relay test with two fake forward endpoints; existing claim tests extended | UC-2, BR-1, LIM-2 |
| AC-2 | A hook event emitted from a listed repository selects the repository binding even though a workspace binding exists for the host; from an unlisted directory it selects the workspace binding | `capture-client` unit tests on `selectManagedCaptureBinding` with mixed bindings | UC-2, UC-3, BR-1, BR-2 |
| AC-3 | With the bundled single-destination policy, `setup` produces the same relay config, host config, and health output as the current release, and the existing setup, lifecycle, and host-writer suites pass unchanged | Existing `capture-agent-setup.test.mjs` fixtures; snapshot of relay config | UC-4, BR-5 |
| AC-4 | `status`, `doctor`, `upgrade`, `disable`, `uninstall` succeed on a config with two workspace bindings plus two repository bindings that matches the active policy, and fail `OWNERSHIP_CONFLICT` on a config that does not (extra binding, missing binding, wrong workspace) | Setup tests through `ownedRelayConfig` / `ownedLocalState` | UC-5, BR-7 |
| AC-5 | Policy load rejects `http://localhost:3000`, `http://10.0.0.5:3000`, a second default, a non-default destination with no repositories, and a repository listed twice; accepts `http://127.0.0.1:3000` as non-default | Policy unit tests | BR-3, BR-4, LIM-5 |
| AC-6 | Relay health for a config spanning two workspaces reports no `WORKSPACE_CONFLICT`, repository attribution `ready`, and per-binding `/health` still returns each binding's own `workspaceId` | Relay health tests | BR-6, UC-5 |
| AC-7 | With one destination's enrollment or probe failing, setup rolls back every destination's state and revokes any token it minted; no relay config is written | Setup transaction tests with a failing second destination | UC-1, BR-8 |
| AC-8 | Real pilot: a Claude Code session and a Codex session in `coredoc-parser` appear in the local server's workspace with repository attribution; a session in a day.io repository appears only on on-prem; the local server receives nothing from the day.io session | Manual pilot check against both servers' session lists | UC-2, UC-3, LIM-1 |

Each critical check could pass while behaviour is broken if the fake endpoints in AC-1 and AC-7 are keyed by binding id rather than by origin, so those fakes must assert on the request URL's origin and workspace path, not on the binding chosen.

## Implementation plan

| Step | Change boundary | Traces to | Depends on |
| --- | --- | --- | --- |
| 1 | `scripts/capture-agent-policy.mjs`: schema v2 `{ schemaVersion: 2, destinations: [{ id, serverOrigin, workspaceId, default?: true, repositories?: [normalizedRepositoryKey] }] }`; v1 input normalised to one default destination; loopback-HTTP exception; overlay merge per ADR-1 | BR-3, BR-4, LIM-6, AC-5 | — |
| 2 | `scripts/managed-otel-relay.mjs` config validation: allow one Codex `workspaceMode` binding plus repository Codex bindings; health treats multiple workspaces as expected when every binding is policy-derived | LIM-2, BR-6, AC-6 | 1 |
| 3 | `scripts/managed-otel-relay.mjs` `registerCodexClaim`: resolve repository scope key first, fall back to the workspace binding only when no repository binding matches | BR-1, BR-2, AC-1 | 2 |
| 4 | `scripts/capture-client.mjs` `selectManagedCaptureBinding`: repository match first, workspace binding as fallback | BR-1, BR-2, AC-2 | — |
| 5 | `scripts/capture-agent-setup.mjs`: `buildRelayConfig` emits default workspace bindings plus repository bindings per destination; enrollment loop per destination with a single rollback scope; `ownedRelayConfig` derives the expected set from the policy; `status`/`doctor` report `destinations[]` | BR-7, BR-8, AC-3, AC-4, AC-7 | 1, 2 |
| 6 | Claude Code per-repository routing per ADR-2 (host-config writer for repository-local settings, or Claude session claims) | LIM-1, AC-8 | 5, ADR-2 |
| 7 | `docs/plugin-managed-capture-agent.md`, `README.md`, `skills/coredoc-capture/SKILL.md`: policy v2, overlay location and permissions, new codes; UPSTREAM.md phase note | contracts | 5 |
| 8 | Pilot: create overlay with the local destination, run setup, verify AC-8 on both servers | AC-8 | 6, unresolved decisions 1 and 2 |

**Validation:** policy and client unit tests first (fast, no I/O); relay claim and health tests; setup transaction tests; then the repository gates: Node suite, bundled-Bun suite, `check:skills`, redact scanner over docs and fixtures, `git diff --check`; finally the pilot check in AC-8.

**Reachable failure modes:**

- Second destination unreachable at setup: whole setup rolls back, first destination's token revoked, existing codes (`DISCOVERY_FAILED`, `OAUTH_TIMEOUT`, `CLOUD_AUTH_REJECTED`) reported with the failing destination id in the JSON; no partial routing.
- Listed repository has no git remote at session time: identity unresolvable, session goes to default (BR-2); `doctor` shows the repository as `unresolved` so the maintainer can see why local capture is empty.
- Overlay present but malformed or world-readable: policy load fails closed before enrollment with a new `POLICY_INVALID` code; bundled policy is not used as a silent fallback because the maintainer explicitly asked for two destinations.
- Local server down while on-prem is up: only the local bindings queue to their outboxes; on-prem forwarding continues; health reports the local binding degraded.
- Repository bindings present in relay config but overlay later removed: `ownedRelayConfig` reports `OWNERSHIP_CONFLICT` (BR-7); documented remedy is to restore the overlay or run `uninstall` with the overlay present, then `setup` without it.

**Rollout/rollback:** ship after the Desktop cutover release. Fleet developers see no change (AC-3). The maintainer adds the overlay and reruns `setup`; rollback is `uninstall` with the overlay, delete the overlay, `setup`, which returns the machine to the single-destination shape. Policy v1 files remain valid, so reverting the plugin version does not strand a fleet install; a multi-destination relay config under a reverted plugin fails `OWNERSHIP_CONFLICT` and needs the same uninstall-first rollback.

## Decisions (ADR)

| ID | Status | Context and alternatives | Decision | Consequences / supersedes |
| --- | --- | --- | --- | --- |
| ADR-1 | accepted | The bundled policy cannot contain a maintainer-only loopback destination. Alternatives: (a) per-machine overlay file under the agent state root, owner-only 0600, merged over the bundled policy and permitted to add only non-default loopback destinations; (b) environment variable pointing at a full replacement policy; (c) a separate maintainer build of the plugin | (a) | Fleet policy stays authoritative for the default destination; an overlay cannot redirect fleet traffic because it may only add loopback non-default destinations; setup and every lifecycle command read the same merged policy |
| ADR-2 | accepted (a) | Claude Code native records cannot carry `cwd`. Alternatives: (a) plugin writes a marker-owned repository-local `.claude/settings.local.json` in each listed repository with that repository binding's nonce header, the mechanism Desktop already used and the design doc already describes as overriding global settings; (b) add a Claude SessionStart claim (`session_id` plus `cwd`) and route Claude native records by the `session.id` attribute with the same buffer-until-claim logic Codex uses, keeping one global config | Recommended (a) for this slice: smallest, proven, and observable per repository. (b) is the cleaner end state and is deferred | (a) touches files inside listed repositories (normally gitignored) and must be removed by `disable`/`uninstall`; (b) would let the plugin stop writing into repositories at all |
| ADR-3 | accepted | Whether a session may reach two destinations. Alternatives: single destination per session; fan-out | Single destination per session | No duplicate sessions across servers; simpler health and outbox accounting; fan-out can be added later as a per-destination flag if a consumer appears |

## Resolved decisions

1. **Local enrollment auth.** The local `coredoc-parser` server checkout already carries the WorkOS AuthKit variables in its `apps/server/.env`, so the normal browser enrollment applies to the loopback destination. No server change; LIM-3 is an operational precondition, not a code gap.
2. **Probe route on the local server.** `capture/v1/probe` exists on `coredoc-parser` `main` (`apps/server/src/modules/capture/capture.controller.ts`, `@Post('probe')`). LIM-4 is withdrawn.
3. **ADR-2.** Option (a), repository-local Claude settings, implemented in `host-global-config.mjs` (`renderClaudeRepositorySettings`) and wired through setup; removed by `disable`, `uninstall`, or a later `setup` that no longer lists the checkout.

## Implementation notes

- Codex native records that arrive before the session's `SessionStart` claim fall back to the default destination (`managed-otel-relay.mjs` `handleCodexNative`); buffering-until-claim is kept only for repository-only configs. The claim hook runs at session start, so the window is the hook latency.
- The identity file gains an optional `repositories` list; identities written by the single-destination release stay readable.
- The runtime manifest (`runtime/capture-agent-manifest.json`) must be re-hashed whenever a file in the bundled closure changes; this change touched `scripts/capture-client.mjs` and `scripts/managed-otel-relay.mjs`.
