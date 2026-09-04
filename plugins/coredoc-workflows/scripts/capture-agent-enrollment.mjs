import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

import {
  loadCaptureAgentPolicy,
  validateCaptureAgentPolicy,
} from "./capture-agent-policy.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ID = /^[\x21-\x7e]{1,512}$/;
const CALLBACK_VALUE = /^[\x21-\x7e]{1,4096}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TELEMETRY_TOKEN = /^cdt_[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const INSTALLATION_RESPONSE_FIELDS = new Set([
  "id",
  "name",
  "token",
  "createdAt",
  "expiresAt",
]);
const OWNED_TOKEN_FIELDS = new Set([
  "id",
  "name",
  "tokenPrefix",
  "createdAt",
  "expiresAt",
  "lastUsedAt",
]);
const TOKEN_PREFIX = /^cdt_[A-Za-z0-9_-]{8}$/;
const MAX_JSON_RESPONSE_BYTES = 64 * 1024;
const MAX_OWNED_TOKENS = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;

export class EnrollmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EnrollmentError";
    this.code = code;
  }
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export function createPkce({ randomBytesImpl = randomBytes } = {}) {
  const verifier = base64url(randomBytesImpl(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytesImpl(16));
  if (verifier.length < 43 || verifier.length > 128) {
    throw new EnrollmentError("PKCE_UNAVAILABLE", "Could not create a valid PKCE verifier.");
  }
  return { verifier, challenge, state };
}

function exactObject(value, fields, code, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EnrollmentError(code, message);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new EnrollmentError(code, message);
  }
  return value;
}

function timestamp(value, field) {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new EnrollmentError(
      "INSTALLATION_RESPONSE_INVALID",
      `Installation token ${field} is invalid.`,
    );
  }
  return value;
}

export function validateInstallationTokenPayload(value, installationId) {
  if (!UUID_V4.test(installationId)) {
    throw new EnrollmentError("INVALID_INPUT", "installationId must be a UUID v4.");
  }
  const candidate = exactObject(
    value,
    INSTALLATION_RESPONSE_FIELDS,
    "INSTALLATION_RESPONSE_INVALID",
    "Installation token response must contain the exact fields expected by the capture agent.",
  );
  if (typeof candidate.id !== "string" || !UUID_V4.test(candidate.id)) {
    throw new EnrollmentError("INSTALLATION_RESPONSE_INVALID", "Installation token id is invalid.");
  }
  const expectedName = `capture-agent:${installationId.toLowerCase()}`;
  if (candidate.name !== expectedName) {
    throw new EnrollmentError("INSTALLATION_RESPONSE_INVALID", "Installation token name does not match the installation.");
  }
  if (typeof candidate.token !== "string" || !TELEMETRY_TOKEN.test(candidate.token)) {
    throw new EnrollmentError("INSTALLATION_RESPONSE_INVALID", "Installation token token is invalid.");
  }
  const createdAt = timestamp(candidate.createdAt, "createdAt");
  const expiresAt =
    candidate.expiresAt === null
      ? null
      : timestamp(candidate.expiresAt, "expiresAt");
  return Object.freeze({
    id: candidate.id.toLowerCase(),
    name: expectedName,
    token: candidate.token,
    createdAt,
    expiresAt,
  });
}

async function jsonResponse(response, code, message) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new EnrollmentError(code, message);
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new EnrollmentError(code, message);
  }
  if (Buffer.byteLength(text) > MAX_JSON_RESPONSE_BYTES) {
    throw new EnrollmentError(code, message);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EnrollmentError(code, message);
  }
}

// Hostnames that always resolve to this machine. A policy may point at a
// loopback HTTP origin (127.0.0.1 or [::1]); such a server commonly advertises
// its OAuth endpoints as `localhost`, so the three names are interchangeable
// there. Any other origin must stay HTTPS and byte-identical.
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "[::1]", "localhost"]);

function isLoopbackHttpOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
  );
}

function sameOriginHttpsEndpoint(value, serverOrigin, field) {
  if (typeof value !== "string") {
    throw new EnrollmentError("DISCOVERY_INVALID", `OAuth discovery ${field} is invalid.`);
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new EnrollmentError("DISCOVERY_INVALID", `OAuth discovery ${field} is invalid.`);
  }
  const server = new URL(serverOrigin);
  const sameOrigin = isLoopbackHttpOrigin(serverOrigin)
    ? endpoint.protocol === "http:" &&
      LOOPBACK_HOSTNAMES.has(endpoint.hostname) &&
      endpoint.port === server.port
    : endpoint.protocol === "https:" && endpoint.origin === serverOrigin;
  if (
    !sameOrigin ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== ""
  ) {
    throw new EnrollmentError("DISCOVERY_INVALID", `OAuth discovery ${field} is invalid.`);
  }
  return endpoint.toString();
}

function boundedRequestSignal(request) {
  const signal = request.createRequestSignal(request.requestTimeoutMs);
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function"
  ) {
    throw new Error("invalid request signal");
  }
  return signal;
}

async function discoverAuthorizationServer(serverOrigin, request) {
  let response;
  try {
    response = await request.fetchImpl(`${serverOrigin}/.well-known/oauth-authorization-server`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: boundedRequestSignal(request),
    });
  } catch {
    throw new EnrollmentError("DISCOVERY_FAILED", "OAuth discovery could not be reached.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new EnrollmentError("DISCOVERY_FAILED", `OAuth discovery failed with HTTP ${response.status}.`);
  }
  const candidate = await jsonResponse(
    response,
    "DISCOVERY_INVALID",
    "OAuth discovery returned an invalid document.",
  );
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new EnrollmentError("DISCOVERY_INVALID", "OAuth discovery returned an invalid document.");
  }
  const issuer = sameOriginHttpsEndpoint(candidate.issuer, serverOrigin, "issuer");
  if (new URL(issuer).pathname !== "/" || new URL(issuer).search !== "") {
    throw new EnrollmentError("DISCOVERY_INVALID", "OAuth discovery issuer is invalid.");
  }
  return {
    authorizationEndpoint: sameOriginHttpsEndpoint(
      candidate.authorization_endpoint,
      serverOrigin,
      "authorization_endpoint",
    ),
    tokenEndpoint: sameOriginHttpsEndpoint(
      candidate.token_endpoint,
      serverOrigin,
      "token_endpoint",
    ),
    registrationEndpoint:
      candidate.registration_endpoint === undefined
        ? undefined
        : sameOriginHttpsEndpoint(
            candidate.registration_endpoint,
            serverOrigin,
            "registration_endpoint",
          ),
  };
}

async function registerClient(registrationEndpoint, redirectUri, request) {
  let response;
  try {
    response = await request.fetchImpl(registrationEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      redirect: "error",
      signal: boundedRequestSignal(request),
      body: JSON.stringify({
        client_name: "coredoc-workflows-capture-agent",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
  } catch {
    throw new EnrollmentError("DCR_FAILED", "OAuth client registration could not be reached.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new EnrollmentError("DCR_FAILED", `OAuth client registration failed with HTTP ${response.status}.`);
  }
  const payload = await jsonResponse(
    response,
    "DCR_INVALID",
    "OAuth client registration returned an invalid response.",
  );
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.client_id !== "string" ||
    !CLIENT_ID.test(payload.client_id)
  ) {
    throw new EnrollmentError("DCR_INVALID", "OAuth client registration returned an invalid response.");
  }
  return payload.client_id;
}

function validClientId(value) {
  if (typeof value !== "string" || !CLIENT_ID.test(value)) {
    throw new EnrollmentError("INVALID_INPUT", "clientId is invalid.");
  }
  return value;
}

async function exchangeCode({ tokenEndpoint, code, verifier, redirectUri, clientId, request }) {
  let response;
  try {
    response = await request.fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      redirect: "error",
      signal: boundedRequestSignal(request),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
      }).toString(),
    });
  } catch {
    throw new EnrollmentError("TOKEN_EXCHANGE_FAILED", "OAuth token exchange could not be reached.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new EnrollmentError(
      "TOKEN_EXCHANGE_FAILED",
      `OAuth token exchange failed with HTTP ${response.status}.`,
    );
  }
  const payload = await jsonResponse(
    response,
    "TOKEN_RESPONSE_INVALID",
    "OAuth token exchange returned an invalid response.",
  );
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.access_token !== "string" ||
    !JWT.test(payload.access_token)
  ) {
    throw new EnrollmentError("TOKEN_RESPONSE_INVALID", "OAuth token exchange returned an invalid response.");
  }
  return payload.access_token;
}

async function rotateInstallationToken({ policy, installationId, accessToken, request }) {
  const endpoint =
    `${policy.serverOrigin}/api/v1/workspaces/${encodeURIComponent(policy.workspaceId)}` +
    `/telemetry-token/installations/${encodeURIComponent(installationId.toLowerCase())}`;
  let response;
  try {
    response = await request.fetchImpl(endpoint, {
      method: "PUT",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      redirect: "error",
      signal: boundedRequestSignal(request),
    });
  } catch {
    throw new EnrollmentError("INSTALLATION_ROTATE_FAILED", "Installation token rotation could not be reached.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new EnrollmentError(
      "INSTALLATION_ROTATE_FAILED",
      `Installation token rotation failed with HTTP ${response.status}.`,
    );
  }
  return validateInstallationTokenPayload(
    await jsonResponse(
      response,
      "INSTALLATION_RESPONSE_INVALID",
      "Installation token rotation returned an invalid response.",
    ),
    installationId,
  );
}

function ownedTimestamp(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new EnrollmentError(
      "OWNED_RESPONSE_INVALID",
      `Owned telemetry token ${field} is invalid.`,
    );
  }
  return value;
}

function validateOwnedTelemetryTokens(value) {
  if (!Array.isArray(value) || value.length > MAX_OWNED_TOKENS) {
    throw new EnrollmentError(
      "OWNED_RESPONSE_INVALID",
      "Owned telemetry token response is invalid.",
    );
  }
  return value.map((entry) => {
    const candidate = exactObject(
      entry,
      OWNED_TOKEN_FIELDS,
      "OWNED_RESPONSE_INVALID",
      "Owned telemetry token response is invalid.",
    );
    if (
      typeof candidate.id !== "string" ||
      !UUID_V4.test(candidate.id) ||
      typeof candidate.name !== "string" ||
      candidate.name.length < 1 ||
      candidate.name.length > 200 ||
      /[\0\r\n]/.test(candidate.name) ||
      (candidate.tokenPrefix !== null &&
        (typeof candidate.tokenPrefix !== "string" ||
          !TOKEN_PREFIX.test(candidate.tokenPrefix)))
    ) {
      throw new EnrollmentError(
        "OWNED_RESPONSE_INVALID",
        "Owned telemetry token response is invalid.",
      );
    }
    return Object.freeze({
      id: candidate.id.toLowerCase(),
      name: candidate.name,
      tokenPrefix: candidate.tokenPrefix,
      createdAt: ownedTimestamp(candidate.createdAt, "createdAt"),
      expiresAt: ownedTimestamp(candidate.expiresAt, "expiresAt", {
        nullable: true,
      }),
      lastUsedAt: ownedTimestamp(candidate.lastUsedAt, "lastUsedAt", {
        nullable: true,
      }),
    });
  });
}

async function authorizedRequest({
  policy,
  accessToken,
  path,
  method,
  request,
  expectedStatus,
  code,
}) {
  let response;
  try {
    response = await request.fetchImpl(`${policy.serverOrigin}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      redirect: "error",
      signal: boundedRequestSignal(request),
    });
  } catch {
    throw new EnrollmentError(code, "Authorized enrollment request could not be reached.");
  }
  if (response.status !== expectedStatus) {
    await response.body?.cancel().catch(() => undefined);
    throw new EnrollmentError(
      code,
      `Authorized enrollment request failed with HTTP ${response.status}.`,
    );
  }
  return response;
}

function authorizedEnrollmentSession({
  policy,
  installationId,
  installationToken,
  accessToken: currentAccessToken,
  request,
}) {
  const workspacePath = `/api/v1/workspaces/${encodeURIComponent(policy.workspaceId)}/telemetry-token`;
  const token = () => currentAccessToken();
  return Object.freeze({
    installationToken,
    async listOwnedTelemetryTokens() {
      const response = await authorizedRequest({
        policy,
        accessToken: token(),
        path: `${workspacePath}/owned`,
        method: "GET",
        request,
        expectedStatus: 200,
        code: "OWNED_LIST_FAILED",
      });
      return validateOwnedTelemetryTokens(
        await jsonResponse(
          response,
          "OWNED_RESPONSE_INVALID",
          "Owned telemetry token response is invalid.",
        ),
      );
    },
    async revokeOwnedTelemetryToken(tokenId) {
      if (typeof tokenId !== "string" || !UUID_V4.test(tokenId)) {
        throw new EnrollmentError("INVALID_INPUT", "tokenId must be a UUID v4.");
      }
      await authorizedRequest({
        policy,
        accessToken: token(),
        path: `${workspacePath}/owned/${encodeURIComponent(tokenId.toLowerCase())}`,
        method: "DELETE",
        request,
        expectedStatus: 204,
        code: "OWNED_REVOKE_FAILED",
      });
    },
    async revokeInstallationToken() {
      await authorizedRequest({
        policy,
        accessToken: token(),
        path: `${workspacePath}/installations/${encodeURIComponent(installationId.toLowerCase())}`,
        method: "DELETE",
        request,
        expectedStatus: 204,
        code: "INSTALLATION_REVOKE_FAILED",
      });
    },
  });
}

function stateMatches(expected, actual) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function waitWithTimeout(promise, timeoutMs, timers) {
  return new Promise((resolve, reject) => {
    const timer = timers.setTimeout(
      () => reject(new EnrollmentError("OAUTH_TIMEOUT", "Browser authorization timed out.")),
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (value) => {
        timers.clearTimeout(timer);
        resolve(value);
      },
      () => {
        timers.clearTimeout(timer);
        reject(new EnrollmentError("OAUTH_CALLBACK_FAILED", "Browser authorization callback failed."));
      },
    );
  });
}

function callbackResult(value, expectedState) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EnrollmentError("OAUTH_CALLBACK_INVALID", "Browser authorization callback is invalid.");
  }
  if (!stateMatches(expectedState, value.state)) {
    throw new EnrollmentError("OAUTH_STATE_MISMATCH", "OAuth state did not match.");
  }
  if (typeof value.error === "string") {
    throw new EnrollmentError("OAUTH_DENIED", "Browser authorization was denied.");
  }
  if (typeof value.code !== "string" || !CALLBACK_VALUE.test(value.code)) {
    throw new EnrollmentError("OAUTH_CALLBACK_INVALID", "Browser authorization callback is missing a valid code.");
  }
  return value.code;
}

export async function createLoopbackCallbackListener() {
  let settle;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => {
    settle = resolve;
    rejectCallback = reject;
  });
  // Discovery and DCR run after the listener starts. Attach a handler now so a
  // rare listener failure during those requests is retained for waitForCallback
  // without becoming an unhandled rejection in the meantime.
  void callback.catch(() => undefined);
  let delivered = false;
  const server = createServer((request, response) => {
    let parsed;
    try {
      parsed = new URL(request.url ?? "", "http://127.0.0.1");
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (request.method !== "GET" || parsed.pathname !== "/oauth/callback") {
      response.writeHead(404).end();
      return;
    }
    if (delivered) {
      response.writeHead(409).end();
      return;
    }
    delivered = true;
    settle({
      code: parsed.searchParams.get("code") ?? undefined,
      state: parsed.searchParams.get("state") ?? undefined,
      error: parsed.searchParams.get("error") ?? undefined,
    });
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end("<!doctype html><title>Coredoc</title><p>Authorization received. You may close this tab.</p>");
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  }).catch(() => {
    throw new EnrollmentError("OAUTH_CALLBACK_FAILED", "Could not start the browser authorization callback.");
  });
  server.on("error", () => {
    rejectCallback(
      new EnrollmentError(
        "OAUTH_CALLBACK_FAILED",
        "Browser authorization callback failed.",
      ),
    );
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new EnrollmentError("OAUTH_CALLBACK_FAILED", "Could not start the browser authorization callback.");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
    waitForCallback: () => callback,
    close: () =>
      new Promise((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      }),
  };
}

export async function openSystemBrowser(url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname))
  ) {
    throw new EnrollmentError("BROWSER_OPEN_FAILED", "Authorization URL must use HTTPS.");
  }
  const executable =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["url.dll,FileProtocolHandler", url]
      : [url];
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "ignore",
      detached: true,
      shell: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  }).catch(() => {
    throw new EnrollmentError("BROWSER_OPEN_FAILED", "Could not open the browser for authorization.");
  });
}

export async function enrollCaptureAgent({
  policy,
  installationId,
  mintInstallationToken = true,
  clientId,
  timeoutMs = 120_000,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
  createRequestSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  createCallbackListener = createLoopbackCallbackListener,
  openBrowser = openSystemBrowser,
  randomBytesImpl = randomBytes,
  timers = { setTimeout, clearTimeout },
  completeEnrollment,
} = {}) {
  const resolvedPolicy = validateCaptureAgentPolicy(
    policy === undefined ? await loadCaptureAgentPolicy() : policy,
  );
  if (typeof installationId !== "string" || !UUID_V4.test(installationId)) {
    throw new EnrollmentError("INVALID_INPUT", "installationId must be a UUID v4.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1000) {
    throw new EnrollmentError("INVALID_INPUT", "timeoutMs is invalid.");
  }
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS ||
    typeof createRequestSignal !== "function"
  ) {
    throw new EnrollmentError("INVALID_INPUT", "request timeout configuration is invalid.");
  }
  if (completeEnrollment !== undefined && typeof completeEnrollment !== "function") {
    throw new EnrollmentError("INVALID_INPUT", "completeEnrollment must be a function.");
  }
  if (typeof mintInstallationToken !== "boolean") {
    throw new EnrollmentError("INVALID_INPUT", "mintInstallationToken must be a boolean.");
  }
  if (!mintInstallationToken && completeEnrollment === undefined) {
    throw new EnrollmentError(
      "INVALID_INPUT",
      "completeEnrollment is required when mintInstallationToken is false.",
    );
  }
  const pkce = createPkce({ randomBytesImpl });
  const listener = await createCallbackListener();
  if (
    listener === null ||
    typeof listener !== "object" ||
    typeof listener.redirectUri !== "string" ||
    typeof listener.waitForCallback !== "function" ||
    typeof listener.close !== "function"
  ) {
    throw new EnrollmentError("OAUTH_CALLBACK_FAILED", "Browser authorization callback is invalid.");
  }
  let accessToken = "";
  try {
    const request = {
      fetchImpl,
      requestTimeoutMs,
      createRequestSignal,
    };
    const redirect = new URL(listener.redirectUri);
    if (
      redirect.protocol !== "http:" ||
      redirect.hostname !== "127.0.0.1" ||
      redirect.pathname !== "/oauth/callback" ||
      redirect.username !== "" ||
      redirect.password !== "" ||
      redirect.search !== "" ||
      redirect.hash !== ""
    ) {
      throw new EnrollmentError("OAUTH_CALLBACK_FAILED", "Browser authorization callback is not loopback-only.");
    }
    const metadata = await discoverAuthorizationServer(
      resolvedPolicy.serverOrigin,
      request,
    );
    const resolvedClientId =
      clientId === undefined
        ? metadata.registrationEndpoint === undefined
          ? (() => {
              throw new EnrollmentError("DCR_REQUIRED", "OAuth discovery requires a pre-registered clientId.");
            })()
          : await registerClient(metadata.registrationEndpoint, listener.redirectUri, request)
        : validClientId(clientId);
    const authorizeUrl = new URL(metadata.authorizationEndpoint);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: resolvedClientId,
      redirect_uri: listener.redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: pkce.state,
      scope: "offline_access",
    }).toString();
    await openBrowser(authorizeUrl.toString());
    const code = callbackResult(
      await waitWithTimeout(listener.waitForCallback(), timeoutMs, timers),
      pkce.state,
    );
    accessToken = await exchangeCode({
      tokenEndpoint: metadata.tokenEndpoint,
      code,
      verifier: pkce.verifier,
      redirectUri: listener.redirectUri,
      clientId: resolvedClientId,
      request,
    });
    const installationToken = mintInstallationToken
      ? await rotateInstallationToken({
          policy: resolvedPolicy,
          installationId,
          accessToken,
          request,
        })
      : null;
    if (completeEnrollment === undefined) return installationToken;
    return await completeEnrollment(
      authorizedEnrollmentSession({
        policy: resolvedPolicy,
        installationId,
        installationToken,
        accessToken: () => accessToken,
        request,
      }),
    );
  } finally {
    accessToken = "";
    try {
      await listener.close();
    } catch {
      // The credential has already been discarded; a close failure must not
      // replace the enrollment result or expose callback details.
    }
  }
}
