import assert from "node:assert/strict";
import test from "../test/test-api.mjs";
import {
  classifyCoredocTool,
  loadCoredocToolClasses,
} from "./coredoc-tool-classes.mjs";

const NAME_RE = /^[a-z][a-z0-9_]*$/;

function isSorted(list) {
  return list.every((value, i) => i === 0 || list[i - 1] < value);
}

function assertToolNameList(list) {
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length > 0, true);
  assert.equal(new Set(list).size, list.length);
  for (const name of list) {
    assert.equal(NAME_RE.test(name), true, `${name} is not a compact tool name`);
  }
  assert.equal(isSorted(list), true, `${JSON.stringify(list)} is not sorted`);
}

test("coredoc-tool-classes: shape", () => {
  const classes = loadCoredocToolClasses();
  assert.equal(classes.version, 1);
  assert.equal(Number.isInteger(classes.version), true);
  assertToolNameList(classes.read);
  assertToolNameList(classes.write);
});

test("coredoc-tool-classes: read and write are disjoint", () => {
  const classes = loadCoredocToolClasses();
  const overlap = classes.read.filter((name) => classes.write.includes(name));
  assert.deepEqual(overlap, []);
});

test("coredoc-tool-classes: byAction tools are excluded from flat lists and have disjoint action lists", () => {
  const classes = loadCoredocToolClasses();
  for (const [toolName, actionClass] of Object.entries(classes.byAction)) {
    assert.equal(classes.read.includes(toolName), false);
    assert.equal(classes.write.includes(toolName), false);
    assert.equal(actionClass.read.length > 0, true);
    assert.equal(actionClass.write.length > 0, true);
    const overlap = actionClass.read.filter((action) =>
      actionClass.write.includes(action),
    );
    assert.deepEqual(overlap, []);
  }
});

test("coredoc-tool-classes: byAction covers intent_handoff", () => {
  const classes = loadCoredocToolClasses();
  assert.deepEqual(classes.byAction.intent_handoff, {
    read: ["get", "list"],
    write: ["save"],
  });
});

test("coredoc-tool-classes: pinned version equals 1", () => {
  assert.equal(loadCoredocToolClasses().version, 1);
});

test("classifyCoredocTool: search_symbols is read", () => {
  assert.deepEqual(classifyCoredocTool("search_symbols", {}), {
    access: "read",
  });
});

test("classifyCoredocTool: intent_propose is write", () => {
  assert.deepEqual(classifyCoredocTool("intent_propose", {}), {
    access: "write",
  });
});

test("coredoc-tool-classes: byAction covers intent_anchor (preview is a read)", () => {
  const classes = loadCoredocToolClasses();
  assert.deepEqual(classes.byAction.intent_anchor, {
    read: ["preview"],
    write: ["add", "refresh", "remove"],
  });
  assert.deepEqual(classifyCoredocTool("intent_anchor", { action: "preview" }), {
    access: "read",
  });
  assert.deepEqual(classifyCoredocTool("intent_anchor", { action: "add" }), {
    access: "write",
  });
});

test("classifyCoredocTool: intent_handoff by action", () => {
  assert.deepEqual(
    classifyCoredocTool("intent_handoff", { action: "get" }),
    { access: "read" },
  );
  assert.deepEqual(
    classifyCoredocTool("intent_handoff", { action: "list" }),
    { access: "read" },
  );
  assert.deepEqual(
    classifyCoredocTool("intent_handoff", { action: "save" }),
    { access: "write" },
  );
  assert.deepEqual(
    classifyCoredocTool("intent_handoff", { action: "nope" }),
    { access: "write", unclassified: true },
  );
  assert.deepEqual(classifyCoredocTool("intent_handoff", {}), {
    access: "write",
    unclassified: true,
  });
});

test("classifyCoredocTool: unknown tool is write and unclassified", () => {
  assert.deepEqual(classifyCoredocTool("never_heard_of", {}), {
    access: "write",
    unclassified: true,
  });
});
