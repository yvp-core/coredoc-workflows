const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CAPABILITY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;

function capabilityId(value) {
  return typeof value === "string" && CAPABILITY_ID_RE.test(value) ? value : "";
}

function capabilityData(payload) {
  if (
    payload?.hook_event_name === "UserPromptExpansion" &&
    payload?.expansion_type === "slash_command"
  ) {
    const id = capabilityId(payload.command_name);
    return id ? { kind: "skill", capabilityId: id, outcome: "unknown" } : null;
  }

  if (
    (payload?.hook_event_name === "PostToolUse" ||
      payload?.hook_event_name === "PostToolUseFailure") &&
    payload?.tool_name === "Skill"
  ) {
    const id = capabilityId(payload?.tool_input?.skill);
    if (!id) return null;
    return {
      kind: "skill",
      capabilityId: id,
      outcome: payload.hook_event_name === "PostToolUse" ? "success" : "failed",
    };
  }

  if (payload?.hook_event_name === "SubagentStart") {
    const id = capabilityId(payload.agent_type);
    return id ? { kind: "agent", capabilityId: id, outcome: "unknown" } : null;
  }
  return null;
}

/** Translate only the allowlisted Claude identity/status fields into C1. */
export function translateClaudeCapability(
  payload,
  { at = new Date().toISOString(), runId } = {},
) {
  const sessionId = payload?.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  const data = capabilityData(payload);
  if (!data) return null;
  return {
    sessionId,
    event: {
      occurredAt: at,
      type: "capability.used",
      ...(runId === undefined ? {} : { runId }),
      data,
    },
  };
}
