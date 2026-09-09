/**
 * The case-fold table is derived from the runtime's own Unicode data. These
 * tests re-derive it from scratch and fail if the hard-coded ranges have
 * drifted, so a Node upgrade that ships new Unicode data cannot silently
 * degrade `i` matching into exact matching.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { caseVariants, foldSet } from "../src/casefold.ts";
import * as cs from "../src/charset.ts";
import { SafeRegExp } from "../src/index.ts";

test("the cased-range table covers every cased code point in this runtime", () => {
  const missing: number[] = [];
  for (let cp = 0; cp <= cs.MAX_CODE_POINT; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    const cased = ch.toLowerCase() !== ch || ch.toUpperCase() !== ch;
    if (!cased) continue;
    // A cased code point must either fold with something, or be one whose
    // only mappings are multi-character expansions (ß -> SS).
    const variants = caseVariants(cp);
    if (variants.length === 1 && cs.size(foldSet(cs.single(cp))) === 1) {
      const expandsOnly =
        [...ch.toUpperCase()].length > 1 || [...ch.toLowerCase()].length > 1 || cp === 0x130 || cp === 0x131;
      if (!expandsOnly) missing.push(cp);
    }
  }
  assert.deepEqual(missing, [], `cased code points outside CASED_RANGES: ${missing.map((c) => c.toString(16)).join(", ")}`);
});

test("fold orbits are symmetric and closed", () => {
  for (const cp of [0x61, 0x4b, 0x212a, 0x17f, 0x3c3, 0x3c2, 0xdf, 0x1e9e]) {
    for (const other of caseVariants(cp)) {
      assert.deepEqual(
        [...caseVariants(other)].sort((a, b) => a - b),
        [...caseVariants(cp)].sort((a, b) => a - b),
        `orbit of U+${cp.toString(16)} vs U+${other.toString(16)}`,
      );
    }
  }
});

test("folding matches the native engine across the BMP", () => {
  // Sampling keeps this quick while still covering every cased block.
  for (let cp = 0; cp <= 0xffff; cp += 7) {
    const ch = String.fromCodePoint(cp);
    for (const probe of ["a", "A", "K", "s", "ſ", "ß"]) {
      const source = SafeRegExp.escape(probe);
      assert.equal(
        new SafeRegExp(source, "i").test(ch),
        new RegExp(source, "iu").test(ch),
        `/${source}/i on U+${cp.toString(16)}`,
      );
    }
  }
});

test("folding a huge set stays cheap", () => {
  const started = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) foldSet(cs.ANY);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 500, `folding ANY 50 times took ${elapsedMs.toFixed(1)}ms`);
});
