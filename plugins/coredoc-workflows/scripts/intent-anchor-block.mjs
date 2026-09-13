import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseAnchorBlock, parseAnchorEnvelope, upsertAnchorBlock } from '../vendor/intent-anchor-mapping.mjs';

export function composeAnchorBody(body, input, check = false) {
  const requested = parseAnchorEnvelope(input);
  if (!requested) throw new Error('Invalid review mapping.');
  if (check) {
    const actual = parseAnchorBlock(body);
    if (actual.kind !== 'parsed' || JSON.stringify(actual.envelope) !== JSON.stringify(requested))
      throw new Error('mapping_block_missing_or_changed: PR body did not retain the reviewed mapping.');
    return body;
  }
  const output = upsertAnchorBlock(body, requested);
  if (Buffer.byteLength(output) > 65536) throw new Error('PR body exceeds 64 KiB.');
  return output;
}

function main(args) {
  const value = (flag) => {
    const at = args.indexOf(flag);
    if (at < 0 || !args[at + 1]) throw new Error(`Missing ${flag}`);
    return args[at + 1];
  };
  const input = value('--input');
  const body = value('--body');
  if (statSync(input).size > 32768 || statSync(body).size > 65536)
    throw new Error('Review mapping or PR body exceeds the size limit.');
  const output = composeAnchorBody(
    readFileSync(body, 'utf8'),
    JSON.parse(readFileSync(input, 'utf8')),
    args.includes('--check'),
  );
  process.stdout.write(args.includes('--check') ? 'mapping block verified\n' : output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
