/**
 * Differential test against the platform's own regexp engine.
 *
 * For every generated pattern/input pair the two engines must agree on
 * whether there is a match, where it starts and ends, and what each capture
 * group holds. Seeds are fixed, so a failure reproduces exactly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SafeRegExp } from "../src/index.ts";
import { UnsupportedPatternError } from "../src/errors.ts";
import {
  hasAstralBoundaryHazard,
  hasNullableLoop,
  randomInput,
  randomPattern,
} from "./support/generate.ts";
import { makeRng } from "./support/rng.ts";

const CASES = 4000;

function describeMatch(m: RegExpExecArray | null): string {
  if (m === null) return "null";
  return JSON.stringify({ index: m.index, groups: Array.from(m) });
}

test("agrees with native RegExp on generated patterns", () => {
  const rng = makeRng(0xc0ffee);
  let compared = 0;
  let capturesCompared = 0;

  for (let i = 0; i < CASES; i++) {
    const source = randomPattern(rng);
    const flags = [rng() < 0.2 ? "i" : "", rng() < 0.2 ? "m" : "", rng() < 0.2 ? "s" : ""].join("");

    let native: RegExp;
    let safe: SafeRegExp;
    try {
      native = new RegExp(source, `${flags}u`);
      safe = new SafeRegExp(source, flags);
    } catch (error) {
      if (error instanceof UnsupportedPatternError) continue;
      // A pattern rejected by the platform is not a useful comparison.
      if (error instanceof SyntaxError) continue;
      throw error;
    }

    const skipCaptures = hasNullableLoop(source);
    for (let k = 0; k < 4; k++) {
      const input = randomInput(rng);
      if (hasAstralBoundaryHazard(source, input)) continue;
      const expected = native.exec(input);
      const actual = safe.exec(input) as RegExpExecArray | null;
      compared++;

      const context = `/${source}/${flags} on ${JSON.stringify(input)}`;
      assert.equal(
        actual === null,
        expected === null,
        `match/no-match disagreement for ${context}\n  native: ${describeMatch(expected)}\n  resafe: ${describeMatch(actual)}`,
      );
      if (expected === null || actual === null) continue;
      if (skipCaptures) continue;

      capturesCompared++;
      assert.equal(
        describeMatch(actual),
        describeMatch(expected),
        `result disagreement for ${context}`,
      );
    }
  }

  assert.ok(compared > CASES * 2, `expected a decent sample, compared ${compared}`);
  assert.ok(capturesCompared > CASES, `expected capture coverage, compared ${capturesCompared}`);
});

test("agrees with native RegExp on global iteration", () => {
  const rng = makeRng(0x5eed);
  for (let i = 0; i < 800; i++) {
    const source = randomPattern(rng);
    let native: RegExp;
    let safe: SafeRegExp;
    try {
      native = new RegExp(source, "gu");
      safe = new SafeRegExp(source, "g");
    } catch (error) {
      if (error instanceof UnsupportedPatternError || error instanceof SyntaxError) continue;
      throw error;
    }
    if (hasNullableLoop(source)) continue;

    const input = randomInput(rng);
    if (hasAstralBoundaryHazard(source, input)) continue;
    const expected = [...input.matchAll(native)].map((m) => [m.index, m[0]]);
    const actual = [...safe.matchAll(input)].map((m) => [m.index, m[0]]);
    assert.deepEqual(actual, expected, `matchAll disagreement for /${source}/g on ${JSON.stringify(input)}`);
  }
});
