import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanPrBodyLines } from '../vendor/intent-anchor-mapping.mjs';
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


test('the methodology body template survives PR composition with live delivery and retirement', () => {
  const body = readFileSync(new URL('../resources/methodology/intent-pr-body.example.md', import.meta.url), 'utf8');
  const output = composeAnchorBody(body, input);
  const { lines, liveIndexes } = scanPrBodyLines(output);
  const live = liveIndexes.map((index) => lines[index]);
  assert.ok(live.includes('Coredoc-Intent-Delivers: br-checkout-policy@2'));
  assert.ok(live.includes('Coredoc-Intent-Retires: lim-old-checkout-policy@3'));
  assert.equal(composeAnchorBody(output, input, true), output);
});

test('body composition preserves visible list continuations and ignores HTML comments', () => {
  const hidden = '<!--\nCoredoc-Intent-Anchors: not live\n-->';
  const body = `- Delivery\n    Coredoc-Intent-Delivers: br-rule@2\n\n${hidden}`;
  const output = composeAnchorBody(body, input);
  const { lines, liveIndexes } = scanPrBodyLines(output);
  assert.ok(liveIndexes.some((index) => lines[index].includes('br-rule@2')));
  assert.equal(composeAnchorBody(output, input, true), output);
});
