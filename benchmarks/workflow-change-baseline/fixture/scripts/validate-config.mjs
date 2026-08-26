import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../config/pricing.json", import.meta.url), "utf8"),
);

assert.equal(Number.isInteger(config.maximumPromotionPercent), true);
assert.equal(config.maximumPromotionPercent >= 0, true);
assert.equal(config.maximumPromotionPercent <= 100, true);
