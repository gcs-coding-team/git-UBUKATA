/**
 * The public, RegExp-shaped API.
 *
 * `SafeRegExp` deliberately mirrors the built-in `RegExp` surface — the same
 * flags, the same `lastIndex` protocol, the same result shape — and implements
 * the well-known symbols, so an instance can be handed straight to
 * `String.prototype.replace`, `split`, `match` and `matchAll`.
 */

import { compile } from "./compiler.ts";
import { Input } from "./input.ts";
import { RegexSyntaxError } from "./errors.ts";
import { PikeVM } from "./pike.ts";
import type { Program } from "./program.ts";

export interface SafeRegExpOptions {
  /** Instruction budget for bounded-repeat expansion. Default 200000. */
  readonly maxProgramSize?: number;
}

/**
 * A match result, shaped like the array `RegExp.prototype.exec` returns.
 *
 * The element type is `string` rather than `string | undefined` to stay
 * assignable to the platform's own `RegExpExecArray`, which lets a
 * `SafeRegExp` be handed straight to `String.prototype.match` and friends.
 * As with the built-in type, a group that did not participate is `undefined`
 * at runtime.
 */
export interface SafeMatchArray extends Array<string> {
  /** UTF-16 index where the match starts. */
  index: number;
  input: string;
  groups: Record<string, string> | undefined;
  /** Present when the `d` flag is set. */
  indices?: SafeMatchIndices;
}

export interface SafeMatchIndices extends Array<[number, number] | undefined> {
  groups: Record<string, [number, number] | undefined> | undefined;
}

const VALID_FLAGS = "dgimsuy";

export class SafeRegExp {
  readonly source: string;
  readonly flags: string;
  readonly global: boolean;
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  readonly dotAll: boolean;
  readonly sticky: boolean;
  readonly hasIndices: boolean;

  /** Where the next `exec` starts when the `g` or `y` flag is set. */
  lastIndex = 0;

  private readonly program: Program;
  private readonly vm: PikeVM;
  private cachedInput: Input | null = null;

  constructor(source: string, flags = "", options: SafeRegExpOptions = {}) {
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (!VALID_FLAGS.includes(flag)) {
        throw new RegexSyntaxError(`unsupported flag '${flag}'`, source, -1);
      }
      if (flags.indexOf(flag) !== i) {
        throw new RegexSyntaxError(`duplicate flag '${flag}'`, source, -1);
      }
    }

    this.source = source;
    this.flags = flags;
    this.hasIndices = flags.includes("d");
    this.global = flags.includes("g");
    this.ignoreCase = flags.includes("i");
    this.multiline = flags.includes("m");
    this.dotAll = flags.includes("s");
    this.sticky = flags.includes("y");

    this.program = compile(source, {
      ignoreCase: this.ignoreCase,
      dotAll: this.dotAll,
      multiline: this.multiline,
      maxProgramSize: options.maxProgramSize,
    });
    this.vm = new PikeVM(this.program);
  }

  /** Escape a literal string so it can be embedded in a pattern. */
  static escape(text: string): string {
    return text.replace(/[$()*+.?[\\\]^{|}\/-]/gu, (ch) => `\\${ch}`);
  }

  get groupNames(): readonly string[] {
    return [...this.program.groupNames.keys()];
  }

  /** The compiled program, for tooling and debugging. */
  get compiled(): Program {
    return this.program;
  }

  /**
   * Instruction visits performed by the most recent match. Exposed as a
   * diagnostic: it is bounded by `O(input x program)` by construction, which
   * is what makes catastrophic backtracking impossible here.
   */
  get stepCount(): number {
    return this.vm.steps;
  }

  private input(text: string): Input {
    if (this.cachedInput === null || this.cachedInput.text !== text) {
      this.cachedInput = new Input(text);
    }
    return this.cachedInput;
  }

  test(text: string): boolean {
    if (!this.global && !this.sticky) {
      const input = this.input(text);
      return this.vm.run(input, { start: 0, sticky: false, captures: false }) !== null;
    }
    return this.exec(text) !== null;
  }

  exec(text: string): SafeMatchArray | null {
    const input = this.input(text);
    const useLastIndex = this.global || this.sticky;
    const startUtf16 = useLastIndex ? this.lastIndex : 0;

    if (startUtf16 > text.length || startUtf16 < 0) {
      if (useLastIndex) this.lastIndex = 0;
      return null;
    }

    const caps = this.vm.run(input, {
      start: input.toCodePointIndex(startUtf16),
      sticky: this.sticky,
      captures: true,
    });

    if (caps === null) {
      if (useLastIndex) this.lastIndex = 0;
      return null;
    }
    if (useLastIndex) this.lastIndex = input.toUtf16Index(caps[1]);
    return this.buildResult(input, caps);
  }

  private buildResult(input: Input, caps: Int32Array): SafeMatchArray {
    const groupCount = this.program.groupCount;
    const slots = new Array<string | undefined>(groupCount + 1);
    const result = slots as unknown as SafeMatchArray;
    const indices = this.hasIndices
      ? (new Array<[number, number] | undefined>(groupCount + 1) as SafeMatchIndices)
      : null;

    for (let g = 0; g <= groupCount; g++) {
      const start = caps[g * 2];
      const end = caps[g * 2 + 1];
      if (start < 0 || end < 0) {
        slots[g] = undefined;
        if (indices) indices[g] = undefined;
        continue;
      }
      const from = input.toUtf16Index(start);
      const to = input.toUtf16Index(end);
      slots[g] = input.text.slice(from, to);
      if (indices) indices[g] = [from, to];
    }

    result.index = input.toUtf16Index(caps[0]);
    result.input = input.text;
    result.groups = undefined;
    if (indices) indices.groups = undefined;

    if (this.program.groupNames.size > 0) {
      const groups: Record<string, string> = Object.create(null);
      const groupIndices: Record<string, [number, number] | undefined> = Object.create(null);
      for (const [name, index] of this.program.groupNames) {
        groups[name] = slots[index] as string;
        if (indices) groupIndices[name] = indices[index];
      }
      result.groups = groups;
      if (indices) indices.groups = groupIndices;
    }
    if (indices) result.indices = indices;
    return result;
  }

  /** Every non-overlapping match, independent of `lastIndex`. */
  *matchAll(text: string): Generator<SafeMatchArray> {
    const input = this.input(text);
    let pos = 0; // code point index
    for (;;) {
      const caps = this.vm.run(input, { start: pos, sticky: this.sticky, captures: true });
      if (caps === null) return;
      yield this.buildResult(input, caps);
      // Empty matches must still make progress, one code point at a time.
      pos = caps[1] > caps[0] ? caps[1] : caps[1] + 1;
      if (pos > input.length) return;
    }
  }

  toString(): string {
    return `/${this.source}/${this.flags}`;
  }

  // -- well-known symbols --------------------------------------------------

  [Symbol.match](text: string): RegExpMatchArray | null {
    if (!this.global) return this.exec(text) as RegExpMatchArray | null;
    const out: string[] = [];
    for (const m of this.matchAll(text)) out.push(m[0]);
    this.lastIndex = 0;
    return out.length === 0 ? null : (out as RegExpMatchArray);
  }

  [Symbol.matchAll](text: string): IterableIterator<RegExpMatchArray> {
    return this.matchAll(text) as unknown as IterableIterator<RegExpMatchArray>;
  }

  [Symbol.search](text: string): number {
    const input = this.input(text);
    const caps = this.vm.run(input, { start: 0, sticky: false, captures: true });
    return caps === null ? -1 : input.toUtf16Index(caps[0]);
  }

  [Symbol.replace](
    text: string,
    replacement: string | ((...args: any[]) => string),
  ): string {
    const matches: SafeMatchArray[] = [];
    if (this.global) {
      for (const m of this.matchAll(text)) matches.push(m);
      this.lastIndex = 0;
    } else {
      const m = this.exec(text);
      if (m) matches.push(m);
    }

    let out = "";
    let position = 0;
    for (const m of matches) {
      out += text.slice(position, m.index);
      if (typeof replacement === "function") {
        const args: any[] = [...m, m.index, text];
        if (m.groups) args.push(m.groups);
        out += String(replacement(...args));
      } else {
        out += expandReplacement(replacement, m, text);
      }
      position = m.index + (m[0] as string).length;
    }
    return out + text.slice(position);
  }

  [Symbol.split](text: string, limit?: number): string[] {
    const max = limit === undefined ? 0xffffffff : limit >>> 0;
    const out: string[] = [];
    if (max === 0) return out;
    if (text.length === 0) {
      return this.vm.run(this.input(text), { start: 0, sticky: false, captures: false }) === null
        ? [text]
        : out;
    }

    let last = 0;
    for (const m of this.matchAll(text)) {
      const end = m.index + m[0].length;
      // A match that consumes nothing at the current split point would produce
      // an infinite stream of empty pieces; the spec skips it.
      if (end === last && m[0].length === 0) continue;
      if (m.index >= text.length) break;
      out.push(text.slice(last, m.index));
      if (out.length === max) return out;
      for (let g = 1; g < m.length; g++) {
        out.push(m[g]);
        if (out.length === max) return out;
      }
      last = end;
    }
    out.push(text.slice(last));
    return out;
  }
}

/** Expand `$&`, `` $` ``, `$'`, `$1`..`$99`, `$<name>` and `$$`. */
function expandReplacement(template: string, match: SafeMatchArray, text: string): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch !== "$" || i === template.length - 1) {
      out += ch;
      continue;
    }
    const next = template[i + 1];
    if (next === "$") {
      out += "$";
      i++;
    } else if (next === "&") {
      out += match[0];
      i++;
    } else if (next === "`") {
      out += text.slice(0, match.index);
      i++;
    } else if (next === "'") {
      out += text.slice(match.index + match[0].length);
      i++;
    } else if (next === "<") {
      const close = template.indexOf(">", i + 2);
      if (close < 0 || !match.groups) {
        out += ch;
      } else {
        out += match.groups[template.slice(i + 2, close)] ?? "";
        i = close;
      }
    } else if (next >= "0" && next <= "9") {
      // Prefer the two-digit reference when the group exists.
      const two = template.slice(i + 1, i + 3);
      const twoNum = Number(two);
      if (two.length === 2 && /^\d\d$/u.test(two) && twoNum > 0 && twoNum < match.length) {
        out += match[twoNum] ?? "";
        i += 2;
      } else {
        const one = Number(next);
        if (one > 0 && one < match.length) {
          out += match[one] ?? "";
          i++;
        } else {
          out += ch;
        }
      }
    } else {
      out += ch;
    }
  }
  return out;
}
