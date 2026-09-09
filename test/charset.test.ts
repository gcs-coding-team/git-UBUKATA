/**
 * Set algebra is the foundation everything else stands on, so it gets
 * property tests: build random sets, then check the invariants that the rest
 * of the engine assumes (sorted, disjoint, non-adjacent) and the identities
 * that make negation and folding safe to compose.
 */
import assert from "node:assert/strict";
import test from "node:test";

import * as cs from "../src/charset.ts";
import { int, makeRng } from "./support/rng.ts";

function randomSet(rng: () => number, limit = 500): cs.CharSet {
  const pairs: number[] = [];
  for (let i = int(rng, 0, 6); i > 0; i--) {
    const lo = int(rng, 0, limit);
    pairs.push(lo, lo + int(rng, 0, 40));
  }
  return cs.normalize(pairs);
}

function assertNormalized(set: cs.CharSet, label: string): void {
  assert.equal(set.length % 2, 0, `${label}: odd range list`);
  for (let i = 0; i < set.length; i += 2) {
    assert.ok(set[i] <= set[i + 1], `${label}: reversed range at ${i}`);
    if (i > 0) {
      assert.ok(set[i] > set[i - 1] + 1, `${label}: adjacent or overlapping ranges at ${i}`);
    }
  }
}

function members(set: cs.CharSet, limit: number): Set<number> {
  const out = new Set<number>();
  for (let cp = 0; cp <= limit; cp++) if (cs.contains(set, cp)) out.add(cp);
  return out;
}

test("normalize produces sorted, disjoint, non-adjacent ranges", () => {
  const rng = makeRng(1);
  for (let i = 0; i < 500; i++) assertNormalized(randomSet(rng), `case ${i}`);
  assert.deepEqual(cs.normalize([5, 9, 10, 12, 1, 2]), [1, 2, 5, 12]);
  assert.deepEqual(cs.normalize([5, 4]), []);
});

test("union, intersect, subtract and negate agree with brute force", () => {
  const rng = makeRng(2);
  const LIMIT = 600;
  for (let i = 0; i < 300; i++) {
    const a = randomSet(rng);
    const b = randomSet(rng);
    const setA = members(a, LIMIT);
    const setB = members(b, LIMIT);

    const union = cs.union(a, b);
    const intersect = cs.intersect(a, b);
    const subtract = cs.subtract(a, b);
    const negate = cs.negate(a);
    for (const label of ["union", "intersect", "subtract", "negate"]) {
      assertNormalized({ union, intersect, subtract, negate }[label]!, label);
    }

    for (let cp = 0; cp <= LIMIT; cp++) {
      assert.equal(cs.contains(union, cp), setA.has(cp) || setB.has(cp), `union at ${cp}`);
      assert.equal(cs.contains(intersect, cp), setA.has(cp) && setB.has(cp), `intersect at ${cp}`);
      assert.equal(cs.contains(subtract, cp), setA.has(cp) && !setB.has(cp), `subtract at ${cp}`);
      assert.equal(cs.contains(negate, cp), !setA.has(cp), `negate at ${cp}`);
    }
  }
});

test("negation is an involution", () => {
  const rng = makeRng(3);
  for (let i = 0; i < 300; i++) {
    const a = randomSet(rng);
    assert.ok(cs.equals(cs.negate(cs.negate(a)), a));
  }
  assert.ok(cs.equals(cs.negate(cs.EMPTY), cs.ANY));
  assert.ok(cs.equals(cs.negate(cs.ANY), cs.EMPTY));
});

test("sizes add up", () => {
  assert.equal(cs.size(cs.ANY), cs.MAX_CODE_POINT + 1);
  assert.equal(cs.size(cs.DIGIT), 10);
  assert.equal(cs.size(cs.WORD), 26 * 2 + 10 + 1);
  assert.equal(cs.size(cs.WORD) + cs.size(cs.NOT_WORD), cs.MAX_CODE_POINT + 1);
});

test("the predefined classes match the ECMAScript definitions", () => {
  for (let cp = 0; cp <= 0xffff; cp++) {
    const ch = String.fromCodePoint(cp);
    assert.equal(cs.contains(cs.DIGIT, cp), /\d/u.test(ch), `\\d at ${cp}`);
    assert.equal(cs.contains(cs.WORD, cp), /\w/u.test(ch), `\\w at ${cp}`);
    assert.equal(cs.contains(cs.SPACE, cp), /\s/u.test(ch), `\\s at ${cp}`);
    assert.equal(cs.contains(cs.DOT, cp), /./u.test(ch), `. at ${cp}`);
  }
});
