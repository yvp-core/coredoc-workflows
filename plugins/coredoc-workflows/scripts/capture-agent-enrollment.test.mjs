import assert from "node:assert/strict";
import test from "node:test";

import {
  EnrollmentError,
  enrollCaptureAgent,
  validateInstallationTokenPayload,
} from "./capture-agent-enrollment.mjs";

const POLICY = {
  schemaVersion: 1,
  serverOrigin: "https://capture.example.test",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";
const ACCESS_TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature";
const TELEMETRY_TOKEN = `cdt_${"a".repeat(64)}`;
const TOKEN_PAYLOAD = {
  id: "33333333-3333-4333-8333-333333333333",
  name: `capture-agent:${INSTALLATION_ID}`,
  token: TELEMETRY_TOKEN,
  createdAt: "2026-09-01T10:00:00.000Z",
  expiresAt: null,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulHarness({ callback, metadata, installPayload } = {}) {
  const requests = [];
  let authorizeUrl;
  let closed = 0;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const parsed = new URL(url);
    if (parsed.pathname === "/.well-known/oauth-authorization-server") {
      return json(
        metadata ?? {
          issuer: POLICY.serverOrigin,
          authorization_endpoint: `${POLICY.serverOrigin}/authorize`,
          token_endpoint: `${POLICY.serverOrigin}/token`,
          registration_endpoint: `${POLICY.serverOrigin}/register`,
        },
      );
    }
    if (parsed.pathname === "/register") return json({ client_id: "capture-client" }, 201);
    if (parsed.pathname === "/token") {
      return json({ access_token: ACCESS_TOKEN, refresh_token: "discard-me", expires_in: 600 });
    }
    if (parsed.pathname.includes("/telemetry-token/installations/")) {
      return json(installPayload ?? TOKEN_PAYLOAD);
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const createCallbackListener = async () => ({
    redirectUri: "http://127.0.0.1:43817/oauth/callback",
    waitForCallback: async () =>
      callback?.(authorizeUrl) ?? {
        code: "authorization-code",
        state: new URL(authorizeUrl).searchParams.get("state"),
      },
    close: async () => {
      closed += 1;
    },
  });
  const openBrowser = async (url) => {
    authorizeUrl = url;
  };
  return {
    requests,
    fetchImpl,
    createCallbackListener,
    openBrowser,
    closed: () => closed,
    authorizeUrl: () => authorizeUrl,
  };
}

test("performs discovery, DCR, PKCE, token exchange, and installation rotation", async () => {
  const harness = successfulHarness();
  const result = await enrollCaptureAgent({
    policy: POLICY,
    installationId: INSTALLATION_ID,
    fetchImpl: harness.fetchImpl,
    createCallbackListener: harness.createCallbackListener,
    openBrowser: harness.openBrowser,
  });

  assert.deepEqual(result, TOKEN_PAYLOAD);
  assert.equal(harness.closed(), 1);

  const authorize = new URL(harness.authorizeUrl());
  assert.equal(authorize.origin, POLICY.serverOrigin);
  assert.equal(authorize.pathname, "/authorize");
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorize.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(authorize.searchParams.get("state"), /^[A-Za-z0-9_-]{22}$/);

  const register = harness.requests.find(({ url }) => new URL(url).pathname === "/register");
  assert.deepEqual(JSON.parse(register.init.body), {
    client_name: "coredoc-workflows-capture-agent",
    redirect_uris: ["http://127.0.0.1:43817/oauth/callback"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });

  const exchange = harness.requests.find(({ url }) => new URL(url).pathname === "/token");
  const form = new URLSearchParams(exchange.init.body);
  assert.equal(exchange.init.method, "POST");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "authorization-code");
  assert.equal(form.get("client_id"), "capture-client");
  assert.match(form.get("code_verifier"), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(form.get("code_verifier"), authorize.searchParams.get("code_challenge"));

  const install = harness.requests.find(({ url }) =>
    new URL(url).pathname.includes("/telemetry-token/installations/"),
  );
  assert.equal(
    install.url,
    `${POLICY.serverOrigin}/api/v1/workspaces/${POLICY.workspaceId}/telemetry-token/installations/${INSTALLATION_ID}`,
  );
  assert.equal(install.init.method, "PUT");
  assert.deepEqual(install.init.headers, {
    accept: "application/json",
    authorization: `Bearer ${ACCESS_TOKEN}`,
  });
  assert.equal(install.init.body, undefined);
  assert.equal(
    harness.requests.every(({ init }) => init.signal instanceof AbortSignal),
    true,
  );
  assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(result).includes("discard-me"), false);
});

test("uses an explicitly supplied public client when discovery has no DCR endpoint", async () => {
  const harness = successfulHarness({
    metadata: {
      issuer: POLICY.serverOrigin,
      authorization_endpoint: `${POLICY.serverOrigin}/authorize`,
      token_endpoint: `${POLICY.serverOrigin}/token`,
    },
  });
  await enrollCaptureAgent({
    policy: POLICY,
    installationId: INSTALLATION_ID,
    clientId: "pre-registered-client",
    fetchImpl: harness.fetchImpl,
    createCallbackListener: harness.createCallbackListener,
    openBrowser: harness.openBrowser,
  });
  assert.equal(harness.requests.some(({ url }) => new URL(url).pathname === "/register"), false);
  assert.equal(new URL(harness.authorizeUrl()).searchParams.get("client_id"), "pre-registered-client");
});

test("keeps browser credentials inside an awaited authorized enrollment session", async () => {
  const harness = successfulHarness();
  const originalFetch = harness.fetchImpl;
  const legacyId = "44444444-4444-4444-8444-444444444444";
  const owned = [{
    id: legacyId,
    name: "otel:legacy",
    tokenPrefix: `cdt_${"b".repeat(8)}`,
    createdAt: "2026-08-01T10:00:00.000Z",
    expiresAt: null,
    lastUsedAt: null,
  }];
  harness.fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/telemetry-token/owned") && init.method === "GET") {
      harness.requests.push({ url: String(url), init });
      return json(owned);
    }
    if (path.endsWith(`/telemetry-token/owned/${legacyId}`) && init.method === "DELETE") {
      harness.requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }
    if (path.endsWith(`/telemetry-token/installations/${INSTALLATION_ID}`) && init.method === "DELETE") {
      harness.requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }
    return originalFetch(url, init);
  };

  const result = await enrollCaptureAgent({
    policy: POLICY,
    installationId: INSTALLATION_ID,
    fetchImpl: harness.fetchImpl,
    createCallbackListener: harness.createCallbackListener,
    openBrowser: harness.openBrowser,
    completeEnrollment: async (session) => {
      assert.deepEqual(Object.keys(session).sort(), [
        "installationToken",
        "listOwnedTelemetryTokens",
        "revokeInstallationToken",
        "revokeOwnedTelemetryToken",
      ]);
      assert.deepEqual(session.installationToken, TOKEN_PAYLOAD);
      assert.equal(JSON.stringify(session).includes(ACCESS_TOKEN), false);
      assert.deepEqual(await session.listOwnedTelemetryTokens(), owned);
      await session.revokeOwnedTelemetryToken(legacyId);
      await session.revokeInstallationToken();
      return { status: "committed" };
    },
  });

  assert.deepEqual(result, { status: "committed" });
  const authorized = harness.requests.filter(
    ({ init }) => typeof init.headers?.authorization === "string",
  );
  assert.equal(authorized.length, 4);
  assert.equal(
    authorized.every(({ init }) => init.headers.authorization === `Bearer ${ACCESS_TOKEN}`),
    true,
  );
  assert.equal(harness.closed(), 1);
});

test("supports an OAuth-authorized session without minting an installation token", async () => {
  const harness = successfulHarness();
  const originalFetch = harness.fetchImpl;
  const legacyId = "44444444-4444-4444-8444-444444444444";
  const owned = [{
    id: legacyId,
    name: "otel:legacy",
    tokenPrefix: `cdt_${"b".repeat(8)}`,
    createdAt: "2026-08-01T10:00:00.000Z",
    expiresAt: null,
    lastUsedAt: null,
  }];
  harness.fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/telemetry-token/owned") && init.method === "GET") {
      harness.requests.push({ url: String(url), init });
      return json(owned);
    }
    if (path.endsWith(`/telemetry-token/owned/${legacyId}`) && init.method === "DELETE") {
      harness.requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }
    if (path.endsWith(`/telemetry-token/installations/${INSTALLATION_ID}`) && init.method === "DELETE") {
      harness.requests.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }
    return originalFetch(url, init);
  };

  const result = await enrollCaptureAgent({
    policy: POLICY,
    installationId: INSTALLATION_ID,
    mintInstallationToken: false,
    fetchImpl: harness.fetchImpl,
    createCallbackListener: harness.createCallbackListener,
    openBrowser: harness.openBrowser,
    completeEnrollment: async (session) => {
      assert.equal(session.installationToken, null);
      assert.deepEqual(await session.listOwnedTelemetryTokens(), owned);
      await session.revokeOwnedTelemetryToken(legacyId);
      await session.revokeInstallationToken();
      return { status: "purged" };
    },
  });

  assert.deepEqual(result, { status: "purged" });
  assert.equal(
    harness.requests.some(({ init }) => init.method === "PUT"),
    false,
  );
  const authorized = harness.requests.filter(
    ({ init }) => typeof init.headers?.authorization === "string",
  );
  assert.deepEqual(authorized.map(({ init }) => init.method), ["GET", "DELETE", "DELETE"]);
  assert.equal(
    authorized.every(({ init }) => init.headers.authorization === `Bearer ${ACCESS_TOKEN}`),
    true,
  );
  assert.equal(harness.closed(), 1);
});

test("rejects invalid auth-only enrollment options before callback or network effects", async () => {
  for (const mintInstallationToken of [false, "false"]) {
    let networkCalls = 0;
    let listenerCalls = 0;
    let browserCalls = 0;
    await assert.rejects(
      enrollCaptureAgent({
        policy: POLICY,
        installationId: INSTALLATION_ID,
        mintInstallationToken,
        fetchImpl: async () => {
          networkCalls += 1;
          throw new Error("must not reach network");
        },
        createCallbackListener: async () => {
          listenerCalls += 1;
          throw new Error("must not create callback listener");
        },
        openBrowser: async () => {
          browserCalls += 1;
        },
      }),
      (error) =>
        error instanceof EnrollmentError &&
        error.code === "INVALID_INPUT",
    );
    assert.equal(networkCalls, 0);
    assert.equal(listenerCalls, 0);
    assert.equal(browserCalls, 0);
  }
});

for (const [name, callback, code] of [
  ["state mismatch", () => ({ code: "code", state: "wrong" }), "OAUTH_STATE_MISMATCH"],
  [
    "authorization error",
    (url) => ({
      error: "access_denied",
      state: new URL(url).searchParams.get("state"),
    }),
    "OAUTH_DENIED",
  ],
  ["missing code", (url) => ({ state: new URL(url).searchParams.get("state") }), "OAUTH_CALLBACK_INVALID"],
]) {
  test(`rejects ${name} and closes the callback listener`, async () => {
    const harness = successfulHarness({ callback });
    await assert.rejects(
      enrollCaptureAgent({
        policy: POLICY,
        installationId: INSTALLATION_ID,
        fetchImpl: harness.fetchImpl,
        createCallbackListener: harness.createCallbackListener,
        openBrowser: harness.openBrowser,
      }),
      (error) => error instanceof EnrollmentError && error.code === code,
    );
    assert.equal(harness.closed(), 1);
    assert.equal(
      harness.requests.some(({ url }) => new URL(url).pathname === "/token"),
      false,
    );
  });
}

test("times out deterministically and closes the listener", async () => {
  const harness = successfulHarness();
  let closed = 0;
  harness.createCallbackListener = async () => ({
    redirectUri: "http://127.0.0.1:43817/oauth/callback",
    waitForCallback: () => new Promise(() => {}),
    close: async () => {
      closed += 1;
    },
  });
  const timers = {
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  };
  await assert.rejects(
    enrollCaptureAgent({
      policy: POLICY,
      installationId: INSTALLATION_ID,
      timeoutMs: 1,
      timers,
      fetchImpl: harness.fetchImpl,
      createCallbackListener: harness.createCallbackListener,
      openBrowser: harness.openBrowser,
    }),
    (error) => error instanceof EnrollmentError && error.code === "OAUTH_TIMEOUT",
  );
  assert.equal(closed, 1);
});

test("fails closed on unsafe discovery endpoints", async () => {
  const harness = successfulHarness({
    metadata: {
      issuer: POLICY.serverOrigin,
      authorization_endpoint: "https://attacker.example/authorize",
      token_endpoint: `${POLICY.serverOrigin}/token`,
      registration_endpoint: `${POLICY.serverOrigin}/register`,
    },
  });
  await assert.rejects(
    enrollCaptureAgent({
      policy: POLICY,
      installationId: INSTALLATION_ID,
      fetchImpl: harness.fetchImpl,
      createCallbackListener: harness.createCallbackListener,
      openBrowser: harness.openBrowser,
    }),
    (error) => error instanceof EnrollmentError && error.code === "DISCOVERY_INVALID",
  );
});

test("redacts upstream response bodies from errors", async () => {
  const secret = "do-not-leak-this-token";
  const harness = successfulHarness();
  const original = harness.fetchImpl;
  harness.fetchImpl = async (url, init) => {
    if (new URL(url).pathname === "/token") return new Response(secret, { status: 401 });
    return original(url, init);
  };
  await assert.rejects(
    enrollCaptureAgent({
      policy: POLICY,
      installationId: INSTALLATION_ID,
      fetchImpl: harness.fetchImpl,
      createCallbackListener: harness.createCallbackListener,
      openBrowser: harness.openBrowser,
    }),
    (error) =>
      error instanceof EnrollmentError &&
      error.code === "TOKEN_EXCHANGE_FAILED" &&
      !error.message.includes(secret),
  );
});

test("bounds every enrollment API phase and preserves its safe timeout code", async () => {
  const phases = [
    { requestNumber: 1, code: "DISCOVERY_FAILED" },
    { requestNumber: 2, code: "DCR_FAILED" },
    { requestNumber: 3, code: "TOKEN_EXCHANGE_FAILED" },
    { requestNumber: 4, code: "INSTALLATION_ROTATE_FAILED" },
  ];
  for (const { requestNumber, code } of phases) {
    const harness = successfulHarness();
    let signalCount = 0;
    const fetchImpl = async (url, init = {}) => {
      if (init.signal?.aborted) throw init.signal.reason;
      return harness.fetchImpl(url, init);
    };
    await assert.rejects(
      enrollCaptureAgent({
        policy: POLICY,
        installationId: INSTALLATION_ID,
        fetchImpl,
        createCallbackListener: harness.createCallbackListener,
        openBrowser: harness.openBrowser,
        requestTimeoutMs: 37,
        createRequestSignal(timeoutMs) {
          assert.equal(timeoutMs, 37);
          signalCount += 1;
          return signalCount === requestNumber
            ? AbortSignal.abort(new Error("bounded timeout"))
            : new AbortController().signal;
        },
      }),
      (error) => error instanceof EnrollmentError && error.code === code,
    );
  }

  for (const [operation, code] of [
    ["list", "OWNED_LIST_FAILED"],
    ["revoke-owned", "OWNED_REVOKE_FAILED"],
    ["revoke-installation", "INSTALLATION_REVOKE_FAILED"],
  ]) {
    const harness = successfulHarness();
    let signalCount = 0;
    const fetchImpl = async (url, init = {}) => {
      if (init.signal?.aborted) throw init.signal.reason;
      return harness.fetchImpl(url, init);
    };
    await assert.rejects(
      enrollCaptureAgent({
        policy: POLICY,
        installationId: INSTALLATION_ID,
        fetchImpl,
        createCallbackListener: harness.createCallbackListener,
        openBrowser: harness.openBrowser,
        requestTimeoutMs: 37,
        createRequestSignal(timeoutMs) {
          assert.equal(timeoutMs, 37);
          signalCount += 1;
          return signalCount === 5
            ? AbortSignal.abort(new Error("bounded timeout"))
            : new AbortController().signal;
        },
        completeEnrollment: async (session) => {
          if (operation === "list") return session.listOwnedTelemetryTokens();
          if (operation === "revoke-owned") {
            return session.revokeOwnedTelemetryToken(
              "44444444-4444-4444-8444-444444444444",
            );
          }
          return session.revokeInstallationToken();
        },
      }),
      (error) => error instanceof EnrollmentError && error.code === code,
    );
  }
});

test("rejects malformed OAuth and installation responses before returning a credential", async () => {
  for (const [path, payload, code] of [
    ["/token", { access_token: "not-a-jwt" }, "TOKEN_RESPONSE_INVALID"],
    [
      "/api/v1/workspaces/11111111-1111-4111-8111-111111111111/telemetry-token/installations/22222222-2222-4222-8222-222222222222",
      { ...TOKEN_PAYLOAD, extra: true },
      "INSTALLATION_RESPONSE_INVALID",
    ],
  ]) {
    const harness = successfulHarness();
    const original = harness.fetchImpl;
    harness.fetchImpl = async (url, init) => {
      if (new URL(url).pathname === path) return json(payload);
      return original(url, init);
    };
    await assert.rejects(
      enrollCaptureAgent({
        policy: POLICY,
        installationId: INSTALLATION_ID,
        fetchImpl: harness.fetchImpl,
        createCallbackListener: harness.createCallbackListener,
        openBrowser: harness.openBrowser,
      }),
      (error) => error instanceof EnrollmentError && error.code === code,
    );
  }
});

for (const [name, payload, expected] of [
  ["extra field", { ...TOKEN_PAYLOAD, extra: true }, /exact fields/],
  ["invalid id", { ...TOKEN_PAYLOAD, id: "not-a-uuid" }, /id/],
  ["wrong name", { ...TOKEN_PAYLOAD, name: "capture-agent:other" }, /name/],
  ["invalid token", { ...TOKEN_PAYLOAD, token: "not-a-token" }, /token/],
  ["invalid createdAt", { ...TOKEN_PAYLOAD, createdAt: "yesterday" }, /createdAt/],
  ["invalid expiresAt", { ...TOKEN_PAYLOAD, expiresAt: 123 }, /expiresAt/],
]) {
  test(`rejects malformed installation token payload with ${name}`, () => {
    assert.throws(
      () => validateInstallationTokenPayload(payload, INSTALLATION_ID),
      expected,
    );
  });
}
