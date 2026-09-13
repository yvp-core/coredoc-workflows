import assert from 'node:assert/strict';
import test from '../test/test-api.mjs';
import { composeAnchorBody } from './intent-anchor-block.mjs';
const input = {
  schemaVersion: 1,
  headSha: 'a'.repeat(40),
  bindings: [{ itemId: 'br-rule', symbols: ['src/file.ts#Service.run'], replaceNodeIds: [] }],
};
test('serializes review before PR; preserves release/unrelated text and checks actual readback', () => {
  const body = 'Summary\n\nCoredoc-Intent-Delivers: br-rule@2\n```text\nCoredoc-Intent-Anchors: documentation example\n```';
  const output = composeAnchorBody(body, input);
  assert.ok(output.startsWith(body));
  assert.equal(composeAnchorBody(output, input, true), output);
  assert.equal(composeAnchorBody(output, input), output);
  assert.throws(() => composeAnchorBody(body, input, true), /mapping_block_missing_or_changed/);
});
test('fails invalid or oversized output before a PR write, preserving review-only boundary', () => {
  assert.throws(() => composeAnchorBody('', {
    ...input, bindings: [{ itemId: 'br-rule@1', files: ['src/x.ts'] }],
  }));
  assert.throws(() => composeAnchorBody('```\nunfinished', input), /unclosed/);
  assert.throws(() => composeAnchorBody('', {
    ...input, bindings: [{ itemId: 'br-rule', files: Array(201).fill('src/x.ts') }],
  }));
});
