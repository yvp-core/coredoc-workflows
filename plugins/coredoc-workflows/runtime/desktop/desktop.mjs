#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9333;
const REQUEST_TIMEOUT_MS = 10_000;
const REF_ATTRIBUTE = "data-electron-qa-ref";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:access[_ -]?token|refresh[_ -]?token|password|secret|api[_ -]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/[•●*]{3,}[A-Za-z0-9_-]*/g, "[REDACTED]");
}

export function assertLoopbackWebSocketUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Electron QA target must expose a loopback ws:// debugger URL");
  }
  return url.href;
}

export function parseElectronEndpoint(env = process.env) {
  const configured = env.ELECTRON_QA_URL;
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error("ELECTRON_QA_URL must use HTTP on a loopback host");
    }
    return url.origin;
  }

  const rawPort = env.ELECTRON_QA_PORT || String(DEFAULT_PORT);
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("ELECTRON_QA_PORT must be an integer between 1024 and 65535");
  }
  const port = Number.parseInt(rawPort, 10);
  if (port < 1024 || port > 65_535) {
    throw new Error("ELECTRON_QA_PORT must be an integer between 1024 and 65535");
  }
  return `http://${DEFAULT_HOST}:${port}`;
}

export function selectElectronTarget(
  targets,
  {
    titleContains = process.env.ELECTRON_QA_TARGET_TITLE,
    urlContains = process.env.ELECTRON_QA_TARGET_URL,
  } = {},
) {
  const pages = targets.filter(
    (target) =>
      target?.type === "page" &&
      typeof target.webSocketDebuggerUrl === "string" &&
      !String(target.url).startsWith("devtools://"),
  );
  const includes = (value, expected) =>
    expected && String(value).toLowerCase().includes(expected.toLowerCase());
  return (
    pages.find((target) => includes(target.title, titleContains)) ||
    pages.find((target) => includes(target.url, urlContains)) ||
    pages[0] ||
    null
  );
}

export function parseElementReference(value) {
  const match = /^@e([1-9]\d*)$/.exec(value || "");
  if (!match) throw new Error('Element reference must look like "@e1"');
  return `e${match[1]}`;
}

class CdpSession {
  constructor(url, WebSocketImpl = WebSocket) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.socket = new this.WebSocketImpl(this.url);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to desktop CDP")), REQUEST_TIMEOUT_MS);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      this.socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Failed to connect to desktop CDP"));
      });
    });
    this.socket.addEventListener("message", (event) => this.#onMessage(event.data));
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
      else pending.resolve(message.result);
      return;
    }
    this.events.push(message);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

async function fetchTargets(endpoint) {
  let response;
  try {
    response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1500) });
  } catch {
    throw new Error(
      `Electron QA endpoint is unavailable at ${endpoint}. Start the development app with a loopback remote-debugging port matching ELECTRON_QA_PORT=${new URL(endpoint).port || DEFAULT_PORT}.`,
    );
  }
  if (!response.ok) throw new Error(`Electron QA discovery failed with HTTP ${response.status}`);
  return response.json();
}

export async function withElectronPage(callback, { env = process.env, target: targetOptions } = {}) {
  const endpoint = parseElectronEndpoint(env);
  const target = selectElectronTarget(await fetchTargets(endpoint), targetOptions || {
    titleContains: env.ELECTRON_QA_TARGET_TITLE,
    urlContains: env.ELECTRON_QA_TARGET_URL,
  });
  if (!target) throw new Error("Electron QA endpoint has no renderer page target");
  const session = new CdpSession(assertLoopbackWebSocketUrl(target.webSocketDebuggerUrl));
  await session.connect();
  try {
    return await callback({ endpoint, target, session });
  } finally {
    session.close();
  }
}

export async function evaluateRenderer(session, expression) {
  const response = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
    throw new Error(redactSensitiveText(detail || "Electron renderer evaluation failed"));
  }
  return response.result?.value;
}

const INSTALL_ERROR_BUFFER = `(() => {
  if (!window.__electronQaErrors) {
    const errors = [];
    Object.defineProperty(window, '__electronQaErrors', { value: errors, configurable: false });
    const record = (kind, value) => {
      const message = value instanceof Error ? value.message : String(value || kind);
      errors.push({ kind, message: message.slice(0, 500) });
      if (errors.length > 100) errors.shift();
    };
    window.addEventListener('error', (event) => record('error', event.error || event.message));
    window.addEventListener('unhandledrejection', (event) => record('unhandledrejection', event.reason));
  }
  return true;
})()`;

const SNAPSHOT_EXPRESSION = `(() => {
  ${INSTALL_ERROR_BUFFER};
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const clean = (value) => String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, '[REDACTED]')
    .replace(/\\bBearer\\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:access[_ -]?token|refresh[_ -]?token|password|secret|api[_ -]?key|authorization)\\s*[:=]\\s*)[^\\s,;]+/gi, '$1[REDACTED]')
    .replace(/\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b/g, '[REDACTED]')
    .replace(/[•●*]{3,}[A-Za-z0-9_-]*/g, '[REDACTED]')
    .replace(/\\s+/g, ' ').trim().slice(0, 180);
  const label = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    const labelled = labelledBy
      ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
      : '';
    const associated = element.labels ? Array.from(element.labels).map((item) => item.textContent || '').join(' ') : '';
    return clean(element.getAttribute('aria-label') || labelled || associated || element.textContent || element.getAttribute('placeholder') || element.getAttribute('title') || element.getAttribute('name'));
  };
  const role = (element) => element.getAttribute('role') || ({
    A: 'link', BUTTON: 'button', INPUT: element.type === 'checkbox' ? 'checkbox' : element.type === 'radio' ? 'radio' : 'textbox',
    TEXTAREA: 'textbox', SELECT: 'combobox', SUMMARY: 'button'
  }[element.tagName] || element.tagName.toLowerCase());
  document.querySelectorAll('[${REF_ATTRIBUTE}]').forEach((element) => element.removeAttribute('${REF_ATTRIBUTE}'));
  const interactiveSelector = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role],[tabindex]:not([tabindex="-1"])';
  const interactive = Array.from(document.querySelectorAll(interactiveSelector)).filter(visible).slice(0, 300);
  const lines = [\`[document] "\${clean(document.title)}" \${location.href}\`];
  interactive.forEach((element, index) => {
    const ref = \`e\${index + 1}\`;
    element.setAttribute('${REF_ATTRIBUTE}', ref);
    const disabled = element.disabled || element.getAttribute('aria-disabled') === 'true' ? ' [disabled]' : '';
    const checked = element.checked === true || element.getAttribute('aria-checked') === 'true' ? ' [checked]' : '';
    lines.push(\`@\${ref} [\${role(element)}] "\${label(element)}"\${disabled}\${checked}\`);
  });
  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).slice(0, 80);
  for (const heading of headings) lines.push(\`[heading level=\${heading.tagName.slice(1)}] "\${clean(heading.textContent)}"\`);
  return lines.join('\\n');
})()`;

export const SCREENSHOT_REDACTION_EXPRESSION = `(() => {
  try { window.__electronQaRestoreScreenshot?.(); } catch {}
  delete window.__electronQaRestoreScreenshot;
  const restores = [];
  const sensitiveAttribute = /(password|secret|token|api[-_ ]?key|oauth|credential)/i;
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi;
  const maskedSecret = /[•●*]{3,}[A-Za-z0-9_-]*/g;
  const controls = Array.from(document.querySelectorAll('input,textarea'));
  for (const control of controls) {
    const descriptor = [control.type, control.name, control.id, control.autocomplete, control.placeholder, control.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ');
    if (control.type === 'password' || sensitiveAttribute.test(descriptor)) {
      const original = control.value;
      restores.push(() => { control.value = original; });
      control.value = '[REDACTED]';
    }
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const textNode = node;
    const original = textNode.nodeValue || '';
    const redacted = original.replace(email, '[REDACTED]').replace(maskedSecret, '[REDACTED]');
    if (redacted !== original) {
      restores.push(() => { textNode.nodeValue = original; });
      textNode.nodeValue = redacted;
    }
  }
  window.__electronQaRestoreScreenshot = () => {
    for (const restore of restores.reverse()) {
      try { restore(); } catch {}
    }
    delete window.__electronQaRestoreScreenshot;
  };
  return restores.length;
})()`;

async function status(options) {
  return withElectronPage(async ({ endpoint, target, session }) => {
    await evaluateRenderer(session, INSTALL_ERROR_BUFFER);
    const renderer = await evaluateRenderer(
      session,
      "({ title: document.title, url: location.href })",
    );
    return { endpoint, targetId: target.id, ...renderer };
  }, options);
}

async function snapshot(options) {
  return withElectronPage(({ session }) => evaluateRenderer(session, SNAPSHOT_EXPRESSION), options);
}

async function click(reference, options) {
  const ref = parseElementReference(reference);
  return withElectronPage(({ session }) =>
    evaluateRenderer(
      session,
      `(() => {
        const element = document.querySelector('[${REF_ATTRIBUTE}="${ref}"]');
        if (!element) throw new Error('Reference ${reference} is missing or stale; run snapshot again');
        element.focus();
        element.click();
        return true;
      })()`,
    ), options,
  );
}

async function fill(reference, value, options) {
  const ref = parseElementReference(reference);
  const serializedValue = JSON.stringify(value);
  return withElectronPage(({ session }) =>
    evaluateRenderer(
      session,
      `(() => {
        const element = document.querySelector('[${REF_ATTRIBUTE}="${ref}"]');
        if (!element) throw new Error('Reference ${reference} is missing or stale; run snapshot again');
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
          throw new Error('Reference ${reference} is not an editable control');
        }
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (!setter) throw new Error('Editable control has no value setter');
        setter.call(element, ${serializedValue});
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    ), options,
  );
}

const FRAME_SETTLE_EXPRESSION =
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))";
const RESTORE_EXPRESSION =
  "(() => { try { window.__electronQaRestoreScreenshot?.(); } finally { delete window.__electronQaRestoreScreenshot; } return true; })()";

export async function captureScreenshot(session, destination, { noRedact = false } = {}) {
  await session.send("Page.bringToFront");
  let redacted = false;
  if (!noRedact) {
    try {
      await evaluateRenderer(session, SCREENSHOT_REDACTION_EXPRESSION);
      redacted = true;
    } catch (error) {
      process.stderr.write(`electron-qa: screenshot redaction skipped (${error.message})\n`);
    }
  }
  try {
    if (redacted) {
      try {
        await evaluateRenderer(session, FRAME_SETTLE_EXPRESSION);
      } catch (error) {
        process.stderr.write(`electron-qa: screenshot frame-settle wait skipped (${error.message})\n`);
      }
    }
    const result = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    writeFileSync(destination, Buffer.from(result.data, "base64"));
  } finally {
    if (redacted) {
      try {
        await evaluateRenderer(session, RESTORE_EXPRESSION);
      } catch (error) {
        process.stderr.write(`electron-qa: screenshot restore evaluate failed (${error.message})\n`);
      }
    }
  }
}

async function screenshot(outputPath, options) {
  if (!outputPath) throw new Error("screenshot requires an output path");
  const destination = isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath);
  await withElectronPage(
    ({ session }) => captureScreenshot(session, destination, { noRedact: options?.noRedact }),
    options,
  );
  return destination;
}

async function consoleErrors(options) {
  return withElectronPage(async ({ session }) => {
    await session.send("Runtime.enable");
    await session.send("Log.enable");
    await evaluateRenderer(session, INSTALL_ERROR_BUFFER);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    const buffered = await evaluateRenderer(session, "window.__electronQaErrors || []");
    const protocol = session.events.flatMap((event) => {
      if (event.method === "Log.entryAdded" && ["error", "warning"].includes(event.params?.entry?.level)) {
        return [{ kind: `log:${event.params.entry.level}`, message: event.params.entry.text }];
      }
      if (event.method === "Runtime.exceptionThrown") {
        return [{ kind: "exception", message: event.params?.exceptionDetails?.text || "Renderer exception" }];
      }
      if (event.method === "Runtime.consoleAPICalled" && event.params?.type === "error") {
        const message = (event.params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
        return [{ kind: "console:error", message }];
      }
      return [];
    });
    return [...buffered, ...protocol].map((entry) => ({
      ...entry,
      message: redactSensitiveText(entry.message),
    }));
  }, options);
}

export function help() {
  return `Electron QA — development app control over loopback CDP

Start the app:
  Configure Electron with --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333
  ELECTRON_QA_PORT=9333 desktop.mjs doctor

Optional target filters:
  ELECTRON_QA_TARGET_TITLE="App name"
  ELECTRON_QA_TARGET_URL="renderer/index.html"

Commands:
  desktop.mjs doctor
  desktop.mjs status
  desktop.mjs snapshot
  desktop.mjs click @e1
  desktop.mjs fill @e2 "value"
  desktop.mjs screenshot /tmp/electron-qa.png
  desktop.mjs screenshot /tmp/electron-qa.png --no-redact
  desktop.mjs console

Screenshots redact email addresses and secret-like controls before capture.
Pass --no-redact to skip redaction (e.g. for canvas-heavy pages where the
redaction pass may hang). Redaction failures also fall back automatically,
with a warning on stderr.
`;
}

export async function runElectronCommand(command, args = [], options) {
  let result;
  if (command === "doctor" || command === "status") result = await status(options);
  else if (command === "snapshot") result = await snapshot(options);
  else if (command === "click") result = await click(args[0], options);
  else if (command === "fill") result = await fill(args[0], args.slice(1).join(" "), options);
  else if (command === "screenshot") {
    const { destination, noRedact } = parseScreenshotArgs(args);
    result = await screenshot(destination, noRedact ? { ...(options ?? {}), noRedact: true } : options);
  } else if (command === "console") result = await consoleErrors(options);
  else throw new Error(`Unknown Electron QA command: ${command}`);
  return result;
}

// --no-redact is screenshot-scoped. Parsing it here, at the entry point every
// CLI front-end shares, keeps the flag working from all of them while other
// commands (fill in particular) never lose a literal argument to stripping.
export function parseScreenshotArgs(args) {
  const positional = args.filter((arg) => arg !== "--no-redact");
  return { destination: positional[0], noRedact: positional.length !== args.length };
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(help());
    return;
  }

  const result = await runElectronCommand(command, rawArgs);

  if (typeof result === "string") process.stdout.write(`${result}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
