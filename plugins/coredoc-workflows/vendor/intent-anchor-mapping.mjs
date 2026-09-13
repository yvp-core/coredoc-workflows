// Generated from @coredoc/core intent/anchor-mapping.ts. Do not hand-edit.
// Source SHA256: 717d574754ce21d19e139800f6756b7c6e3a0e256d6a8d81be92143a08c4662e
const BLOCK_PREFIX = 'Coredoc-Intent-Anchors: ';
const MAX_BLOCK_BYTES = 32 * 1024;
const MAX_BINDINGS = 50;
const MAX_TARGETS = 200;
const ITEM_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SHA = /^[a-f0-9]{40}$/;
const ALLOWED_ENVELOPE_KEYS = new Set(['schemaVersion', 'headSha', 'bindings']);
const ALLOWED_BINDING_KEYS = new Set(['itemId', 'files', 'symbols', 'replaceNodeIds']);
function closesFence(line, fence) {
    // CommonMark fences allow at most three leading spaces (spec §4.5).
    const trimmed = line.replace(/^ {0,3}/, '').replace(/[ \t]+$/, '');
    return trimmed.length >= fence.length && [...trimmed].every((character) => character === fence.marker);
}
/** Markdown examples are data, never live mapping or delivery instructions. */
export function scanPrBodyLines(body) {
    const lines = body.split(/\r?\n/);
    const liveIndexes = [];
    let fence;
    for (const [index, line] of lines.entries()) {
        const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        const validOpener = opener && !(opener[1][0] === '`' && opener[2].includes('`'));
        if (!fence && validOpener) {
            const run = opener[1];
            fence = { marker: run[0], length: run.length };
        }
        else if (fence) {
            if (closesFence(line, fence))
                fence = undefined;
        }
        else if (!/^( {4}| {0,3}\t)/.test(line))
            liveIndexes.push(index);
    }
    return { lines, liveIndexes, unclosedFence: fence !== undefined };
}
function liveLines(body) {
    const { lines, liveIndexes, unclosedFence } = scanPrBodyLines(body);
    const blocks = [];
    let hasDelivery = false;
    for (const index of liveIndexes) {
        const line = lines[index];
        const block = /^\s*Coredoc-Intent-Anchors\s*:\s*(.*)$/i.exec(line);
        if (block)
            blocks.push({ index, encoded: block[1] });
        if (/^\s*Coredoc-Intent-Delivers\s*:/i.test(line))
            hasDelivery = true;
    }
    return { lines, blocks, hasDelivery, unclosedFence };
}
function exactKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.has(key));
}
function strings(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}
function relativePath(value) {
    if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\') || value.includes('\0'))
        return false;
    const parts = value.split('/');
    return parts.length > 0 && parts.every((part) => part !== '' && part !== '.' && part !== '..');
}
function symbolLocator(value) {
    const split = value.lastIndexOf('#');
    return split > 0 && split < value.length - 1 && relativePath(value.slice(0, split));
}
function binding(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (!exactKeys(record, ALLOWED_BINDING_KEYS))
        return undefined;
    if (typeof record.itemId !== 'string' || record.itemId.length > 64 || !ITEM_ID.test(record.itemId))
        return undefined;
    const files = record.files ?? [];
    const symbols = record.symbols ?? [];
    const replaceNodeIds = record.replaceNodeIds ?? [];
    if (!strings(files) || !strings(symbols) || !strings(replaceNodeIds))
        return undefined;
    if (!files.every(relativePath) || !symbols.every(symbolLocator) || replaceNodeIds.some((id) => id.length > 500))
        return undefined;
    if (files.length + symbols.length + replaceNodeIds.length === 0)
        return undefined;
    return { itemId: record.itemId, files, symbols, replaceNodeIds };
}
function envelope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (!exactKeys(record, ALLOWED_ENVELOPE_KEYS))
        return undefined;
    if (record.schemaVersion !== 1 || typeof record.headSha !== 'string' || !SHA.test(record.headSha))
        return undefined;
    if (!Array.isArray(record.bindings) || record.bindings.length > MAX_BINDINGS)
        return undefined;
    const bindings = record.bindings.map(binding);
    if (bindings.some((entry) => entry === undefined))
        return undefined;
    const concrete = bindings;
    if (new Set(concrete.map((entry) => entry.itemId)).size !== concrete.length)
        return undefined;
    const targetCount = concrete.reduce((count, entry) => count + entry.files.length + entry.symbols.length + entry.replaceNodeIds.length, 0);
    if (targetCount > MAX_TARGETS)
        return undefined;
    return { schemaVersion: 1, headSha: record.headSha, bindings: concrete };
}
/** Validate a structured transport envelope without uploading the rest of the PR body. */
export function parseAnchorEnvelope(value) {
    const parsed = envelope(value);
    return parsed && Buffer.byteLength(`${BLOCK_PREFIX}${JSON.stringify(parsed)}`, 'utf8') <= MAX_BLOCK_BYTES
        ? parsed
        : undefined;
}
export function parseAnchorBlock(body) {
    const live = liveLines(body);
    if (live.blocks.length === 0) {
        return live.hasDelivery ? { kind: 'skipped', reason: 'mapping_block_missing' } : { kind: 'no_mapping' };
    }
    if (live.blocks.length !== 1)
        return { kind: 'skipped', reason: 'mapping_block_invalid' };
    const encoded = live.blocks[0].encoded;
    if (Buffer.byteLength(live.lines[live.blocks[0].index], 'utf8') > MAX_BLOCK_BYTES)
        return { kind: 'skipped', reason: 'mapping_block_oversized' };
    try {
        const parsed = envelope(JSON.parse(encoded));
        return parsed ? { kind: 'parsed', envelope: parsed } : { kind: 'skipped', reason: 'mapping_block_invalid' };
    }
    catch {
        return { kind: 'skipped', reason: 'mapping_block_invalid' };
    }
}
export function renderAnchorBlock(value) {
    const parsed = envelope(value);
    if (!parsed)
        throw new Error('Cannot render an invalid intent anchor envelope');
    const rendered = `${BLOCK_PREFIX}${JSON.stringify(parsed)}`;
    if (Buffer.byteLength(rendered, 'utf8') > MAX_BLOCK_BYTES)
        throw new Error(`Cannot render an intent anchor block larger than ${MAX_BLOCK_BYTES} bytes`);
    return rendered;
}
export function upsertAnchorBlock(body, value) {
    const replacement = renderAnchorBlock(value);
    const live = liveLines(body);
    if (live.unclosedFence)
        throw new Error('Cannot update a PR body with an unclosed code fence');
    if (live.blocks.length > 1)
        throw new Error('Cannot update a PR body with duplicate live anchor blocks');
    const block = live.blocks[0];
    if (block) {
        live.lines[block.index] = replacement;
    }
    else
        live.lines.push(replacement);
    const updated = live.lines.join('\n');
    const readBack = parseAnchorBlock(updated);
    if (readBack.kind !== 'parsed' || JSON.stringify(readBack.envelope) !== JSON.stringify(value)) {
        throw new Error('Updated PR body did not read back as the requested intent anchor block');
    }
    return updated;
}
