/**
 * Simple case folding for the `i` flag.
 *
 * The engine folds character *sets* at compile time rather than folding the
 * input at match time. That ordering matters: a negated class has to be
 * complemented **after** folding, otherwise `/[^a]/i` would happily match `A`.
 *
 * The fold orbit of a code point is derived from the host's own Unicode data
 * (`toUpperCase`/`toLowerCase`), so it tracks whatever Unicode version the
 * runtime ships. `test/casefold.test.ts` re-derives CASED_RANGES from the
 * runtime and fails if this table has drifted.
 */

import type { CharSet } from "./charset.ts";
import { intersect, normalize, union } from "./charset.ts";

/**
 * Every code point whose upper/lower case mapping differs from itself, merged
 * into 32 ranges (gaps of <= 16 code points are absorbed to keep this compact).
 * Scanning all of it costs ~3.3k iterations, done once, lazily.
 */
const CASED_RANGES: readonly number[] = [
  0x41, 0x7a, 0xb5, 0x29e, 0x345, 0x345, 0x370, 0x587, 0x10a0, 0x10ff, 0x13a0, 0x13fd, 0x1c80,
  0x1cbf, 0x1d79, 0x1d7d, 0x1d8e, 0x1d8e, 0x1e00, 0x1ffc, 0x2126, 0x2132, 0x214e, 0x214e, 0x2160,
  0x2184, 0x24b6, 0x24e9, 0x2c00, 0x2d2d, 0xa640, 0xa66d, 0xa680, 0xa69b, 0xa722, 0xa7dc, 0xa7f5,
  0xa7f6, 0xab53, 0xab53, 0xab70, 0xabbf, 0xfb00, 0xfb17, 0xff21, 0xff5a, 0x10400, 0x1044f,
  0x104b0, 0x104fb, 0x10570, 0x105bc, 0x10c80, 0x10cf2, 0x10d50, 0x10d85, 0x118a0, 0x118df,
  0x16e40, 0x16e7f, 0x16ea0, 0x16ed3, 0x1e900, 0x1e943,
];

/**
 * Dotted capital I and dotless small i are deliberately excluded from simple
 * case folding by Unicode (and therefore by `u`-mode ECMAScript regexps), even
 * though `toUpperCase`/`toLowerCase` happily relate them to `i`/`I`.
 */
const FOLD_EXCLUDED = new Set([0x130, 0x131]);

/** Canonical representative of a fold orbit, or -1 when the point is uncased. */
function foldKey(cp: number): number {
  if (FOLD_EXCLUDED.has(cp)) return -1;
  const ch = String.fromCodePoint(cp);
  const upper = ch.toUpperCase();
  // Multi-character expansions (ß -> SS, ﬁ -> FI) have no single-code-point
  // representative, so those points only fold with things that map onto them.
  const u = [...upper].length === 1 ? upper : ch;
  const lower = u.toLowerCase();
  const l = [...lower].length === 1 ? lower : u;
  return l.codePointAt(0)!;
}

let orbits: Map<number, readonly number[]> | null = null;

/** cp -> every code point sharing its fold orbit (including cp itself). */
function foldOrbits(): Map<number, readonly number[]> {
  if (orbits) return orbits;
  const byKey = new Map<number, number[]>();
  for (let i = 0; i < CASED_RANGES.length; i += 2) {
    for (let cp = CASED_RANGES[i]; cp <= CASED_RANGES[i + 1]; cp++) {
      const key = foldKey(cp);
      if (key < 0) continue;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(cp);
      else byKey.set(key, [cp]);
    }
  }
  const map = new Map<number, readonly number[]>();
  for (const [key, members] of byKey) {
    if (!members.includes(key)) members.push(key);
    if (members.length < 2) continue; // folds only with itself: nothing to record
    for (const cp of members) map.set(cp, members);
  }
  orbits = map;
  return map;
}

const CASED_SET: CharSet = normalize(CASED_RANGES);

/** Every code point that is case-equivalent to `cp` (including `cp`). */
export function caseVariants(cp: number): readonly number[] {
  return foldOrbits().get(cp) ?? [cp];
}

/**
 * Close a set under case folding: `[Z]` becomes `[Zz]`, `[a-c]` becomes
 * `[a-cA-C]`. Only the cased slice of the set is scanned, so folding `.` or a
 * huge range stays cheap.
 */
export function foldSet(set: CharSet): CharSet {
  const cased = intersect(set, CASED_SET);
  if (cased.length === 0) return set;
  const map = foldOrbits();
  const extra: number[] = [];
  for (let i = 0; i < cased.length; i += 2) {
    for (let cp = cased[i]; cp <= cased[i + 1]; cp++) {
      const orbit = map.get(cp);
      if (!orbit) continue;
      for (const other of orbit) extra.push(other, other);
    }
  }
  return extra.length === 0 ? set : union(set, normalize(extra));
}
