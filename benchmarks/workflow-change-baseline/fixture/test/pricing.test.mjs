import assert from "node:assert/strict";
import test from "node:test";

import {
  checkoutTotal,
  discountFor,
  renewalTotal,
} from "../src/pricing.mjs";

test("returns the configured membership discounts", () => {
  assert.equal(discountFor("bronze"), 0);
  assert.equal(discountFor("silver"), 10);
  assert.equal(discountFor("gold"), 20);
  assert.equal(discountFor("unknown"), 0);
});

test("applies discounts to checkout and renewal totals", () => {
  assert.equal(checkoutTotal(100, "gold"), 80);
  assert.equal(renewalTotal(100, "silver"), 90);
});
