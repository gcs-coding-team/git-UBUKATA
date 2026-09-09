/**
 * Character sets are stored as a flat array of inclusive code point ranges:
 *
 *   [lo0, hi0, lo1, hi1, ...]
 *
 * The ranges are kept sorted by `lo` and are guaranteed to be non-overlapping
 * and non-adjacent, so membership is a binary search and set algebra is a
 * linear merge. Everything in this module is a pure function over that shape.
 */

export const MAX_CODE_POINT = 0x10ffff;

/** A normalized set of Unicode code points. */
export type CharSet = readonly number[];

export const EMPTY: CharSet = [];
export const ANY: CharSet = [0, MAX_CODE_POINT];

/** Build a normalized set from arbitrary (possibly overlapping) range pairs. */
export function normalize(pairs: readonly number[]): CharSet {
  if (pairs.length === 0) return EMPTY;
  if (pairs.length % 2 !== 0) throw new Error("range list must have even length");

  const idx: number[] = [];
  for (let i = 0; i < pairs.length; i += 2) idx.push(i);
  idx.sort((a, b) => pairs[a] - pairs[b] || pairs[a + 1] - pairs[b + 1]);

  const out: number[] = [];
  let lo = -1;
  let hi = -2;
  for (const i of idx) {
    const l = pairs[i];
    const h = pairs[i + 1];
    if (h < l) continue; // empty range
    if (l > hi + 1) {
      if (hi >= lo) out.push(lo, hi);
      lo = l;
      hi = h;
    } else if (h > hi) {
      hi = h;
    }
  }
  if (hi >= lo) out.push(lo, hi);
  return out;
}

export function single(cp: number): CharSet {
  return [cp, cp];
}

export function isEmpty(set: CharSet): boolean {
  return set.length === 0;
}

/** Number of code points in the set. */
export function size(set: CharSet): number {
  let n = 0;
  for (let i = 0; i < set.length; i += 2) n += set[i + 1] - set[i] + 1;
  return n;
}

/**
 * Membership test: O(log n) binary search over the range list.
 *
 * This is the innermost operation of the whole engine — it runs for every
 * (thread, input position) pair — so it opens with a bounds check that
 * rejects most non-members outright and a fast path for single-range sets,
 * which is what a plain literal character compiles to.
 */
export function contains(set: CharSet, cp: number): boolean {
  const length = set.length;
  if (length === 0) return false;
  if (cp < set[0] || cp > set[length - 1]) return false;
  if (length === 2) return true; // the bounds check already decided it

  let lo = 0;
  let hi = (length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const base = mid << 1;
    if (cp < set[base]) hi = mid - 1;
    else if (cp > set[base + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

export function union(...sets: readonly CharSet[]): CharSet {
  const pairs: number[] = [];
  for (const s of sets) pairs.push(...s);
  return normalize(pairs);
}

/** Complement over the whole Unicode code point space. */
export function negate(set: CharSet): CharSet {
  const out: number[] = [];
  let next = 0;
  for (let i = 0; i < set.length; i += 2) {
    if (set[i] > next) out.push(next, set[i] - 1);
    next = set[i + 1] + 1;
    if (next > MAX_CODE_POINT) break;
  }
  if (next <= MAX_CODE_POINT) out.push(next, MAX_CODE_POINT);
  return out;
}

export function intersect(a: CharSet, b: CharSet): CharSet {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i], b[j]);
    const hi = Math.min(a[i + 1], b[j + 1]);
    if (lo <= hi) out.push(lo, hi);
    if (a[i + 1] < b[j + 1]) i += 2;
    else j += 2;
  }
  return out; // already sorted and disjoint
}

export function subtract(a: CharSet, b: CharSet): CharSet {
  return intersect(a, negate(b));
}

export function equals(a: CharSet, b: CharSet): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Predefined classes (\d, \w, \s and friends)
// ---------------------------------------------------------------------------

export const DIGIT: CharSet = [0x30, 0x39];
export const WORD: CharSet = normalize([0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a]);

/** WhiteSpace ∪ LineTerminator, matching the ECMAScript definition of \s. */
export const SPACE: CharSet = normalize([
  0x09, 0x0d, 0x20, 0x20, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f,
  0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff,
]);

/** LineTerminator: LF, CR, U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR. */
export const LINE_TERMINATOR: CharSet = normalize([0x0a, 0x0a, 0x0d, 0x0d, 0x2028, 0x2029]);

export const NOT_WORD = negate(WORD);
/** `.` without the `s` flag. */
export const DOT = negate(LINE_TERMINATOR);
