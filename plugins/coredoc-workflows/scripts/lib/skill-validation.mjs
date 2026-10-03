// Dependency-free validation of the top-level Markdown fences and the bounded,
// strict-YAML, single-line name/description frontmatter this plugin ships on
// both hosts.
export function unclosedFenceLine(body) {
  let open;
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const [, run, tail] = match;
    if (!open) {
      if (run[0] === "`" && tail.includes("`")) continue;
      open = { marker: run[0], length: run.length, line: index + 1 };
    } else if (run[0] === open.marker && run.length >= open.length && /^\s*$/.test(tail)) {
      open = undefined;
    }
  }
  return open?.line ?? null;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const DOUBLE_QUOTED_ESCAPE = /\\(?:[0abtnvfre "/\\N_LP\t]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/g;

// Why a scalar on one frontmatter line fails a strict YAML parser, or null.
// Hosts load frontmatter with real parsers (Codex validates with PyYAML's
// safe_load), so a value a line regex accepts can still make a skill unloadable.
function yamlScalarProblem(value) {
  if (value === "") return null;
  const rest = (tail) => (/^(?:\s+#.*|\s*)$/.test(tail) ? null : "text after the closing quote");
  if (value[0] === '"') {
    const match = /^"((?:[^"\\]|\\.)*)"(.*)$/.exec(value);
    if (!match) return "an unterminated double-quoted scalar";
    if (match[1].replace(DOUBLE_QUOTED_ESCAPE, "").includes("\\")) return "an invalid escape in a double-quoted scalar";
    return rest(match[2]);
  }
  if (value[0] === "'") {
    const match = /^'((?:[^']|'')*)'(.*)$/.exec(value);
    return match ? rest(match[2]) : "an unterminated single-quoted scalar";
  }
  if (/^[,[\]{}#&*!|>%@`]/.test(value) || /^[-?:](?:\s|$)/.test(value)) {
    return `a plain scalar that starts with the indicator "${value[0]}"`;
  }
  if (/:(?:\s|$)/.test(value)) return 'an unquoted ": " (a mapping indicator)';
  if (/\s#/.test(value)) return 'an unquoted " #" (a comment that truncates the value)';
  return null;
}

// Strict YAML for the subset these skills ship: flat `key: scalar` lines. Nested
// structure is valid YAML but is reported, so the check is extended before any
// skill relies on it rather than passing it unexamined.
export function frontmatterYamlProblems(body) {
  const frontmatter = FRONTMATTER.exec(body)?.[1];
  if (frontmatter === undefined) return ["Missing skill frontmatter"];
  const problems = [];
  const keys = new Set();
  for (const [index, line] of frontmatter.split(/\r?\n/).entries()) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const entry = /^([A-Za-z][\w-]*):(?:[ \t]+(.*?))?\s*$/.exec(line);
    if (!entry) {
      problems.push(`frontmatter line ${index + 2} is not a flat "key: value" entry`);
      continue;
    }
    const [, key, value = ""] = entry;
    if (keys.has(key)) problems.push(`frontmatter key "${key}" is duplicated`);
    keys.add(key);
    const problem = yamlScalarProblem(value);
    if (problem) problems.push(`frontmatter "${key}" is not strict YAML: ${problem}`);
  }
  return problems;
}

export function skillFootprint(body) {
  const frontmatter = FRONTMATTER.exec(body)?.[1];
  if (frontmatter === undefined) throw new Error("Missing skill frontmatter");
  const values = ["name", "description"].map((key) => {
    const value = new RegExp(`^${key}: ([^\\r\\n]+)$`, "m").exec(frontmatter)?.[1]?.trim();
    if (!value || /^[>|]/.test(value)) throw new Error(`${key} must be a nonempty single-line scalar`);
    return value;
  });
  return {
    catalogBytes: values.reduce((total, value) => total + Buffer.byteLength(value), 0),
    bodyBytes: Buffer.byteLength(body),
  };
}

export function validateSkillCorpus(skills, budgets) {
  const problems = [];
  let catalogBytes = 0;
  for (const [name, body] of skills) {
    const line = unclosedFenceLine(body);
    if (line !== null) problems.push(`${name}:${line}: unclosed code fence`);
    try {
      const size = skillFootprint(body);
      for (const problem of frontmatterYamlProblems(body)) problems.push(`${name}: ${problem}`);
      catalogBytes += size.catalogBytes;
      if (size.catalogBytes > budgets.perSkillCatalogMaxBytes) {
        problems.push(`${name}: name + description ${size.catalogBytes} B exceeds ${budgets.perSkillCatalogMaxBytes} B`);
      }
      const ceiling = budgets.skillMaxBytes[name];
      if (!Number.isInteger(ceiling) || ceiling <= 0) problems.push(`${name}: missing body budget`);
      else if (size.bodyBytes > ceiling) problems.push(`${name}: body ${size.bodyBytes} B exceeds ${ceiling} B`);
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }
  for (const name of Object.keys(budgets.skillMaxBytes)) {
    if (!skills.has(name)) problems.push(`${name}: stale body budget`);
  }
  if (skills.size === 0) problems.push("No skills were checked");
  if (catalogBytes > budgets.catalogMaxBytes) {
    problems.push(`Catalog ${catalogBytes} B exceeds ${budgets.catalogMaxBytes} B`);
  }
  return problems;
}
