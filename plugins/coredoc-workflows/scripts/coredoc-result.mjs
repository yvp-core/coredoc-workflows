/**
 * Normalise what a Coredoc MCP tool answered into one of six results.
 *
 * Pure: the hook name, the tool's compact name, the raw `tool_response` and,
 * for the action-dispatching tools, `tool_input.action`. Nothing is retained.
 *
 * Envelope shapes seen on real hosts (fixtures under `hosts/fixtures/gates/`):
 * Claude Code 2.1.272 hands the hook a BARE array of content blocks and signals
 * a hard failure as `PostToolUseFailure` without a `tool_response`; Codex CLI
 * 0.150.1 hands over the raw MCP result object `{ content: [...] }` and never
 * fires `PostToolUseFailure`. No captured payload carries `isError`, but an MCP
 * transport may set it on the object form, so it is honoured.
 */

const INTENT_TOOL_RE = /^(?:get_intent_context|intent_[a-z0-9_]+)$/;

/** Cloud intent refusals answer a top-level `status` (intent.tools.ts `errorState`). */
export const STATUS_RESULTS = Object.freeze({
  error: "error",
  permission_denied: "denied",
  not_configured: "not_configured",
  invalid: "invalid",
});

/** The local overlay answers its own status instead (get-intent-context.ts). */
export const OVERLAY_STATUS_RESULTS = Object.freeze({
  invalid: "invalid",
  not_configured: "not_configured",
});

/**
 * Per-tool positive markers. An empty collection is still a successful read, so
 * markers test for presence and type, never for content.
 * - `anyArray`: at least one of these keys holds an array.
 * - `anyKey`: at least one of these keys is present.
 * - `allKeys`: every one of these keys is present.
 * - `itemsWithOutcome`: `items` is an array whose entries each carry `outcome`.
 * - `byAction`: the marker depends on `tool_input.action`.
 */
export const POSITIVE_MARKERS = Object.freeze({
  get_intent_context: { anyArray: ["matches", "entries", "items", "ids"] },
  intent_propose: { itemsWithOutcome: true },
  intent_review: { anyArray: ["decisions"] },
  intent_release: { anyArray: ["entries"], anyKey: ["contentHash", "event"] },
  intent_anchor: { anyArray: ["anchors"] },
  intent_tree: { anyKey: ["id"] },
  intent_handoff: {
    byAction: {
      get: { allKeys: ["id", "version"] },
      list: { anyArray: ["operations"] },
      save: { allKeys: ["id", "version", "mapping", "delivery"] },
    },
  },
});

/**
 * The normalisation table of issue 01 as data: one row per documented line,
 * each with a sample the test feeds straight through `normalizeCoredocResult`.
 */
export const RESULT_TABLE = Object.freeze([
  {
    row: "hook PostToolUseFailure",
    sample: { hookName: "PostToolUseFailure", tool: "search_symbols" },
    result: "error",
  },
  {
    row: "MCP envelope isError",
    sample: {
      hookName: "PostToolUse",
      tool: "get_intent_context",
      toolResponse: { isError: true, content: [{ type: "text", text: "boom" }] },
    },
    result: "error",
  },
  {
    row: "cloud intent status error",
    sample: {
      hookName: "PostToolUse",
      tool: "get_intent_context",
      toolResponse: [{ type: "text", text: '{"status":"error","error":{"code":"invalid_page_limit"}}' }],
    },
    result: "error",
  },
  {
    row: "cloud intent status permission_denied",
    sample: {
      hookName: "PostToolUse",
      tool: "intent_propose",
      toolResponse: [{ type: "text", text: '{"status":"permission_denied","requires":{}}' }],
    },
    result: "denied",
  },
  {
    row: "cloud intent status not_configured",
    sample: {
      hookName: "PostToolUse",
      tool: "get_intent_context",
      toolResponse: [{ type: "text", text: '{"status":"not_configured","message":"empty"}' }],
    },
    result: "not_configured",
  },
  {
    row: "cloud intent status invalid",
    sample: {
      hookName: "PostToolUse",
      tool: "intent_review",
      toolResponse: [{ type: "text", text: '{"status":"invalid"}' }],
    },
    result: "invalid",
  },
  {
    row: "local overlayStatus invalid",
    sample: {
      hookName: "PostToolUse",
      tool: "get_intent_context",
      toolResponse: [{ type: "text", text: '{"overlayStatus":"invalid","items":[]}' }],
    },
    result: "invalid",
  },
  {
    row: "local overlayStatus not_configured",
    sample: {
      hookName: "PostToolUse",
      tool: "get_intent_context",
      toolResponse: [{ type: "text", text: '{"overlayStatus":"not_configured","items":[]}' }],
    },
    result: "not_configured",
  },
  {
    row: "intent tool with its positive marker",
    sample: {
      hookName: "PostToolUse",
      tool: "get_intent_context",
      toolResponse: [{ type: "text", text: '{"overlayStatus":"ready","items":[]}' }],
    },
    result: "ok",
  },
  {
    row: "intent tool without a marker",
    sample: {
      hookName: "PostToolUse",
      tool: "intent_review",
      toolResponse: [{ type: "text", text: '{"note":"no decisions here"}' }],
    },
    result: "unknown",
  },
  {
    row: "intent tool with an unparsable answer",
    sample: {
      hookName: "PostToolUse",
      tool: "get_intent_context",
      toolResponse: [{ type: "text", text: "## Intent\n\nplain prose" }],
    },
    result: "unknown",
  },
  {
    row: "graph tool on PostToolUse",
    sample: {
      hookName: "PostToolUse",
      tool: "search_symbols",
      toolResponse: [{ type: "text", text: "## Search results\n\n**0 results**" }],
    },
    result: "ok",
  },
]);

/** Both hosts' wrappers: a bare content-block array, or the raw MCP result. */
function contentBlocks(toolResponse) {
  if (Array.isArray(toolResponse)) return toolResponse;
  return Array.isArray(toolResponse?.content) ? toolResponse.content : [];
}

/** The first text block parsed as a JSON object, or undefined. */
function parsedAnswer(toolResponse) {
  const block = contentBlocks(toolResponse).find(
    (entry) => entry?.type === "text",
  );
  if (typeof block?.text !== "string") return undefined;
  try {
    const value = JSON.parse(block.text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function isIntentTool(tool) {
  return typeof tool === "string" && INTENT_TOOL_RE.test(tool);
}

function markerMatches(marker, body) {
  if (!marker) return false;
  if (marker.byAction) return false;
  if (marker.itemsWithOutcome) {
    return (
      Array.isArray(body.items) &&
      body.items.every((item) => typeof item?.outcome === "string")
    );
  }
  if (
    Array.isArray(marker.anyArray) &&
    marker.anyArray.some((key) => Array.isArray(body[key]))
  ) {
    return true;
  }
  if (
    Array.isArray(marker.anyKey) &&
    marker.anyKey.some((key) => body[key] !== undefined)
  ) {
    return true;
  }
  return (
    Array.isArray(marker.allKeys) &&
    marker.allKeys.every((key) => body[key] !== undefined)
  );
}

function hasPositiveMarker(tool, body, action) {
  const marker = POSITIVE_MARKERS[tool];
  if (!marker) return false;
  if (marker.byAction) {
    return typeof action === "string"
      ? markerMatches(marker.byAction[action], body)
      : false;
  }
  return markerMatches(marker, body);
}

/**
 * `ok | error | denied | not_configured | invalid | unknown` for one observed
 * Coredoc tool call. An intent tool never reaches `ok` without its marker.
 */
export function normalizeCoredocResult({
  hookName,
  tool,
  toolResponse,
  action,
} = {}) {
  if (hookName === "PostToolUseFailure") return "error";
  if (toolResponse?.isError === true) return "error";
  if (!isIntentTool(tool)) return "ok";

  const body = parsedAnswer(toolResponse);
  if (!body) return "unknown";
  if (typeof body.status === "string" && STATUS_RESULTS[body.status]) {
    return STATUS_RESULTS[body.status];
  }
  if (
    typeof body.overlayStatus === "string" &&
    OVERLAY_STATUS_RESULTS[body.overlayStatus]
  ) {
    return OVERLAY_STATUS_RESULTS[body.overlayStatus];
  }
  return hasPositiveMarker(tool, body, action) ? "ok" : "unknown";
}
