// Dependency-free validation of the top-level Markdown fences and the bounded
// single-line name/description frontmatter this plugin ships on both hosts.
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

export function skillFootprint(body) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1];
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
