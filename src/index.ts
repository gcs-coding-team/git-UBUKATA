/**
 * resafe — a ReDoS-safe regular expression engine.
 *
 * Matching runs a Thompson NFA simulation (a Pike VM) rather than a
 * backtracker, so a match costs O(pattern x input) in the worst case. The
 * price is that backreferences and lookaround are rejected at compile time:
 * they are the features that make a "regular" expression stop being regular.
 */

export { SafeRegExp } from "./regex.ts";
export type { SafeMatchArray, SafeMatchIndices, SafeRegExpOptions } from "./regex.ts";
export { RegexError, RegexSyntaxError, RegexCompileError, UnsupportedPatternError } from "./errors.ts";
export { compile } from "./compiler.ts";
export type { CompileOptions } from "./compiler.ts";
export { disassemble, Op } from "./program.ts";
export type { Inst, Program } from "./program.ts";
export { parse } from "./parser.ts";
export type { Node, ParseResult } from "./ast.ts";

import { SafeRegExp } from "./regex.ts";

/** Convenience constructor: `re("\\d+", "g")`. */
export function re(source: string, flags?: string): SafeRegExp {
  return new SafeRegExp(source, flags);
}
