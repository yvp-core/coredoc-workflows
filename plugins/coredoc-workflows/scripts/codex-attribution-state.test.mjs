import assert from "node:assert/strict";
import test from "../test/test-api.mjs";

import {
  MAX_CODEX_ATTRIBUTION_CLAIMS,
  setCodexAttributionClaim,
} from "./codex-attribution-state.mjs";

const bindingId = "11111111-1111-4111-8111-111111111111";
const repositoryScopeKey = "repo-111111111111111111111111";

function claim(index) {
  const claimedAt = new Date(Date.UTC(2026, 7, 18, 0, 0, index)).toISOString();
  return {
    bindingId,
    repositoryScopeKey,
    claimedAt,
    expiresAt: new Date(Date.parse(claimedAt) + 60_000).toISOString(),
  };
}

test("bounds persisted Codex claims by evicting the oldest mapping", () => {
  const state = {
    schemaVersion: 1,
    claims: {},
    health: {},
    unattributed: { pendingCount: 0, rejectedCount: 0 },
  };
  for (let index = 0; index < MAX_CODEX_ATTRIBUTION_CLAIMS; index += 1) {
    setCodexAttributionClaim(
      state,
      `session-${String(index).padStart(4, "0")}`,
      claim(index)
    );
  }

  setCodexAttributionClaim(
    state,
    "session-new",
    claim(MAX_CODEX_ATTRIBUTION_CLAIMS)
  );

  assert.equal(Object.keys(state.claims).length, MAX_CODEX_ATTRIBUTION_CLAIMS);
  assert.equal(state.claims["session-0000"], undefined);
  assert.deepEqual(
    state.claims["session-new"],
    claim(MAX_CODEX_ATTRIBUTION_CLAIMS)
  );
});
