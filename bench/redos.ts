/**
 * The headline demonstration: what a backtracking engine does with an
 * ambiguous pattern, and what an NFA simulation does with the same one.
 *
 *   node --experimental-strip-types bench/redos.ts
 */

import { SafeRegExp } from "../src/index.ts";

function timeMs(fn: () => void): number {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function fmt(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  return `${(ms * 1000).toFixed(0)} us`;
}

const EVIL = [
  { source: "(a+)+$", fill: "a", tail: "!" },
  { source: "^(a|a)*$", fill: "a", tail: "!" },
  { source: "^(\\w+\\s?)*$", fill: "a", tail: "!" },
  { source: "(x+x+)+y", fill: "x", tail: "z" },
];

const NATIVE_BUDGET_MS = 1500;

console.log("catastrophic backtracking\n");

for (const { source, fill, tail } of EVIL) {
  console.log(`  /${source}/  on  "${fill}".repeat(n) + "${tail}"`);
  console.log(`    ${"n".padStart(8)}  ${"native RegExp".padStart(14)}  ${"resafe".padStart(12)}`);

  const native = new RegExp(source, "u");
  const safe = new SafeRegExp(source);
  let nativeAlive = true;

  for (const n of [10, 20, 25, 28, 30, 32, 1_000, 100_000]) {
    const input = fill.repeat(n) + tail;
    let nativeCell = "  (skipped)";
    if (nativeAlive) {
      const elapsed = timeMs(() => void native.test(input));
      nativeCell = fmt(elapsed);
      if (elapsed > NATIVE_BUDGET_MS) nativeAlive = false;
    }
    const safeCell = fmt(timeMs(() => void safe.test(input)));
    console.log(`    ${String(n).padStart(8)}  ${nativeCell.padStart(14)}  ${safeCell.padStart(12)}`);
  }
  console.log();
}

console.log("throughput on well-behaved patterns (no backtracking blowup)\n");

const CORPUS = Array.from({ length: 2000 }, (_, i) =>
  i % 3 === 0
    ? `2026-09-${String((i % 28) + 1).padStart(2, "0")} user${i}@example.com`
    : `line ${i}: nothing interesting here at all`,
).join("\n");

const WORKLOADS = [
  { name: "date + email", source: "(\\d{4})-(\\d{2})-(\\d{2}) (\\w+)@([\\w.]+)" },
  { name: "word scan", source: "\\b\\w{5,}\\b" },
  { name: "literal-ish", source: "nothing interesting" },
];

console.log(`    ${"pattern".padEnd(16)}${"native".padStart(12)}${"resafe".padStart(12)}${"ratio".padStart(9)}`);
for (const { name, source } of WORKLOADS) {
  const native = new RegExp(source, "gu");
  const safe = new SafeRegExp(source, "g");
  const nativeMs = timeMs(() => {
    let count = 0;
    for (const _ of CORPUS.matchAll(native)) count++;
    if (count < 0) throw new Error("unreachable");
  });
  const safeMs = timeMs(() => {
    let count = 0;
    for (const _ of safe.matchAll(CORPUS)) count++;
    if (count < 0) throw new Error("unreachable");
  });
  console.log(
    `    ${name.padEnd(16)}${fmt(nativeMs).padStart(12)}${fmt(safeMs).padStart(12)}${`${(safeMs / nativeMs).toFixed(1)}x`.padStart(9)}`,
  );
}

console.log("\n  A backtracker wins on patterns it can handle; the point is that it has");
console.log("  no worst case bound, and this one does.");
