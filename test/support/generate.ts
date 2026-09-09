/**
 * Random pattern generator for differential testing. It only emits constructs
 * that exist in both engines with identical semantics, so any disagreement is
 * a real bug rather than a known divergence.
 */
import { int, pick } from "./rng.ts";
import type { Node } from "../../src/ast.ts";
import { parse } from "../../src/parser.ts";

const LITERALS = ["a", "b", "c", "1", "2", " ", "-", "x", "\u00e9", "\u{1f600}", "K", "\\u0041"];
const CLASSES = [
  "\\d", "\\w", "\\s", "\\D", "\\W", "\\S", ".",
  "[abc]", "[^ab]", "[a-c1-2]", "[\\d-]", "[^\\W]", "[\\s\\S]", "[a-\u{1f64f}]", "[\u00e0-\u00ff]",
];
const ANCHORS = ["^", "$", "\\b", "\\B"];

export function randomPattern(rng: () => number, depth = 0): string {
  const roll = rng();

  if (depth > 3 || roll < 0.28) return pick(rng, LITERALS);
  if (roll < 0.45) return pick(rng, CLASSES);
  if (roll < 0.5) return pick(rng, ANCHORS);

  if (roll < 0.62) {
    const parts: string[] = [];
    for (let i = int(rng, 2, 3); i > 0; i--) parts.push(randomPattern(rng, depth + 1));
    return parts.join("");
  }
  if (roll < 0.72) {
    const parts: string[] = [];
    for (let i = int(rng, 2, 3); i > 0; i--) parts.push(randomPattern(rng, depth + 1));
    return `(?:${parts.join("|")})`;
  }
  if (roll < 0.84) {
    const inner = randomPattern(rng, depth + 1);
    const quantifier = pick(rng, ["*", "+", "?", "{2}", "{1,3}", "{0,2}", "{2,}"]);
    const lazy = rng() < 0.3 ? "?" : "";
    return `(?:${inner})${quantifier}${lazy}`;
  }
  const inner = randomPattern(rng, depth + 1);
  return rng() < 0.5 ? `(${inner})` : `(?:${inner})`;
}

const INPUT_ALPHABET = [
  ..."aabbc12 -x\nZ",
  "\u00e9", "\u00c9", "\u{1f600}", "\u{1f64f}", "\u017f", "K", "\u0130", "\u0131", "\u00df",
];

export function randomInput(rng: () => number): string {
  const length = int(rng, 0, 12);
  let out = "";
  for (let i = 0; i < length; i++) out += pick(rng, INPUT_ALPHABET);
  return out;
}

/**
 * True when some quantifier has an *optional* iteration over a body that can
 * match the empty string.
 *
 * ECMAScript's RepeatMatcher fails any optional iteration that consumed
 * nothing, and backtracks into the body to look for a longer one. An NFA
 * simulation has no equivalent rule, so for these patterns the two engines can
 * pick different matches of the same starting position. The accepted language
 * is unaffected, so match/no-match still has to agree — only the captures are
 * excluded from comparison.
 */
export function hasNullableLoop(source: string): boolean {
  return walk(parse(source).node);
}

function walk(node: Node): boolean {
  switch (node.type) {
    case "Repeat":
      if (node.max > node.min && nullable(node.body)) return true;
      return walk(node.body);
    case "Group":
      return walk(node.body);
    case "Concat":
      return node.body.some(walk);
    case "Alt":
      return node.options.some(walk);
    default:
      return false;
  }
}

function nullable(node: Node): boolean {
  switch (node.type) {
    case "Empty":
    case "Assert":
      return true;
    case "Char":
      return false;
    case "Group":
      return nullable(node.body);
    case "Concat":
      return node.body.every(nullable);
    case "Alt":
      return node.options.some(nullable);
    case "Repeat":
      return node.min === 0 || nullable(node.body);
  }
}

/**
 * V8 lets `\b` and `\B` match at a position strictly inside a surrogate pair
 * even under the `u` flag: `/\B/gu` on "x\u{1F600}\u{1F600}ab" reports index 2.
 * `RegExpBuiltinExec` can never hand that index to the matcher (AdvanceStringIndex
 * steps over the whole pair, and lastIndex 2 maps back to code point index 1),
 * so those positions are excluded from the comparison rather than reproduced.
 */
export function hasAstralBoundaryHazard(source: string, input: string): boolean {
  if (!/\\[bB]/u.test(source)) return false;
  for (let i = 0; i < input.length; i++) {
    const unit = input.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) return true;
  }
  return false;
}
