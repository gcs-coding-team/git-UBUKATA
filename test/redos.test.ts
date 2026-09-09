/**
 * The linear-time guarantee, asserted structurally rather than by stopwatch.
 *
 * Every pattern here is a textbook catastrophic-backtracking case: run them
 * through a backtracking engine and the work grows exponentially with the
 * input. The Pike VM visits each program counter at most once per input
 * position per thread list, so the total work is bounded by
 * `3 * (n + 1) * programSize` — and that bound is what these tests check, so
 * they cannot go flaky on a loaded machine.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { SafeRegExp } from "../src/index.ts";

/** Classic catastrophic-backtracking patterns, with what they do on "aaa...". */
const EVIL_PATTERNS: readonly { source: string; matchesAllA: boolean }[] = [
  { source: "(a+)+$", matchesAllA: true },
  { source: "(a|a)*$", matchesAllA: true },
  { source: "(a*)*b", matchesAllA: false },
  { source: "^(\\w+\\s?)*$", matchesAllA: true },
  { source: "(x+x+)+y", matchesAllA: false },
  { source: "^(a|b|ab)+$", matchesAllA: true },
  { source: "(.*a){20}b", matchesAllA: false },
];

test("catastrophic patterns stay within the O(n * m) step bound", () => {
  for (const { source, matchesAllA } of EVIL_PATTERNS) {
    const re = new SafeRegExp(source);
    const programSize = re.compiled.insts.length;

    for (const n of [50, 500, 5000]) {
      const input = "a".repeat(n);
      assert.equal(re.test(input), matchesAllA, `/${source}/ on ${n} a's`);
      const bound = 3 * (n + 1) * programSize;
      assert.ok(
        re.stepCount <= bound,
        `/${source}/ on ${n} chars used ${re.stepCount} steps, above the ${bound} bound`,
      );
    }
  }
});

test("work grows linearly, not exponentially, with input length", () => {
  const re = new SafeRegExp("(a+)+$");
  const steps = [1000, 2000, 4000].map((n) => {
    re.test("a".repeat(n) + "!");
    return re.stepCount;
  });

  // Doubling the input at most doubles the work (plus slack for the constant).
  assert.ok(steps[1] / steps[0] < 2.2, `2x input caused ${steps[1] / steps[0]}x work`);
  assert.ok(steps[2] / steps[1] < 2.2, `2x input caused ${steps[2] / steps[1]}x work`);
});

test("a pattern that hangs a backtracker finishes promptly", () => {
  // 40 characters is already ~2^40 backtracking paths for this pattern.
  const re = new SafeRegExp("(a+)+$");
  const input = "a".repeat(40) + "!";
  const started = process.hrtime.bigint();
  assert.equal(re.test(input), false);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `took ${elapsedMs.toFixed(1)}ms`);
});

test("bounded repetition is capped instead of exhausting memory", () => {
  assert.throws(() => new SafeRegExp("(?:(?:a{1000}){1000}){1000}"), /instructions/u);
  assert.doesNotThrow(() => new SafeRegExp("a{1000}"));
});
