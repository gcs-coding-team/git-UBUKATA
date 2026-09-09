/**
 * Recursive descent parser for the supported subset of ECMAScript regexp
 * syntax. The grammar is:
 *
 *   alternation := sequence ('|' sequence)*
 *   sequence    := quantified*
 *   quantified  := atom quantifier?
 *   quantifier  := ('*' | '+' | '?' | '{' n (',' m?)? '}') '?'?
 *   atom        := '(' group | '[' class | '.' | '^' | '$' | '\' escape | char
 *
 * Patterns are always parsed in Unicode mode: the source is read by code
 * point, so `.` matches an astral character as one unit, exactly like a native
 * regexp with the `u` flag.
 */

import type { CharSet } from "./charset.ts";
import * as cs from "./charset.ts";
import type { Node, ParseResult } from "./ast.ts";
import { foldSet } from "./casefold.ts";
import { RegexSyntaxError, UnsupportedPatternError } from "./errors.ts";

export interface ParseOptions {
  /** When true, `.` also matches line terminators (the `s` flag). */
  readonly dotAll?: boolean;
  /**
   * When true, every character set is closed under case folding *before* any
   * negation is applied. The order matters: folding `[^a]` after complementing
   * it would let it match `A`.
   */
  readonly ignoreCase?: boolean;
}

const SYNTAX_CHARS = new Set("^$\\.*+?()[]{}|/");

class Parser {
  private readonly src: string;
  private readonly dotAll: boolean;
  private readonly ignoreCase: boolean;
  private pos = 0;
  private groupCount = 0;
  private readonly groupNames = new Map<string, number>();

  constructor(src: string, options: ParseOptions) {
    this.src = src;
    this.dotAll = options.dotAll ?? false;
    this.ignoreCase = options.ignoreCase ?? false;
  }

  /** Close a set under case folding when the `i` flag is set. */
  private fold(set: CharSet): CharSet {
    return this.ignoreCase ? foldSet(set) : set;
  }

  /** A complemented class escape such as `\\D`: fold first, then negate. */
  private foldNegate(set: CharSet): CharSet {
    return cs.negate(this.fold(set));
  }

  parse(): ParseResult {
    const node = this.parseAlternation();
    if (this.pos < this.src.length) {
      // The only way to stop early is an unbalanced ')'.
      this.fail("unmatched ')'", this.pos);
    }
    return { node, groupCount: this.groupCount, groupNames: this.groupNames };
  }

  // -- helpers ------------------------------------------------------------

  private fail(message: string, index = this.pos): never {
    throw new RegexSyntaxError(message, this.src, index);
  }

  private unsupported(message: string, index = this.pos): never {
    throw new UnsupportedPatternError(message, this.src, index);
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private eat(ch: string): boolean {
    if (this.src.startsWith(ch, this.pos)) {
      this.pos += ch.length;
      return true;
    }
    return false;
  }

  /** Read one full code point (never splits a surrogate pair). */
  private nextCodePoint(): number {
    const cp = this.src.codePointAt(this.pos);
    if (cp === undefined) this.fail("unexpected end of pattern");
    this.pos += cp > 0xffff ? 2 : 1;
    return cp;
  }

  // -- grammar ------------------------------------------------------------

  private parseAlternation(): Node {
    const options: Node[] = [this.parseSequence()];
    while (this.eat("|")) options.push(this.parseSequence());
    return options.length === 1 ? options[0] : { type: "Alt", options };
  }

  private parseSequence(): Node {
    const body: Node[] = [];
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === "|" || ch === ")") break;
      body.push(this.parseQuantified());
    }
    if (body.length === 0) return { type: "Empty" };
    return body.length === 1 ? body[0] : { type: "Concat", body };
  }

  private parseQuantified(): Node {
    const atomStart = this.pos;
    const atom = this.parseAtom();
    const quant = this.parseQuantifier();
    if (!quant) return atom;

    if (atom.type === "Assert") {
      this.fail("nothing to repeat: a quantifier cannot follow an assertion", atomStart);
    }
    if (this.parseQuantifier()) {
      this.fail("nothing to repeat: a quantifier cannot follow another quantifier", this.pos - 1);
    }
    return { type: "Repeat", body: atom, min: quant.min, max: quant.max, greedy: quant.greedy };
  }

  private parseQuantifier(): { min: number; max: number; greedy: boolean } | null {
    const start = this.pos;
    let min: number;
    let max: number;

    if (this.eat("*")) {
      min = 0;
      max = Infinity;
    } else if (this.eat("+")) {
      min = 1;
      max = Infinity;
    } else if (this.eat("?")) {
      min = 0;
      max = 1;
    } else if (this.peek() === "{") {
      const braced = this.tryParseBracedQuantifier();
      if (!braced) {
        // In Unicode mode a bare '{' is never a literal.
        this.fail("lone '{' (use '\\{' to match a literal brace)", start);
      }
      min = braced.min;
      max = braced.max;
    } else {
      return null;
    }

    const greedy = !this.eat("?");
    if (max < min) this.fail("quantifier range is out of order (max < min)", start);
    return { min, max, greedy };
  }

  private tryParseBracedQuantifier(): { min: number; max: number } | null {
    const start = this.pos;
    this.pos++; // '{'
    const min = this.readDecimal();
    if (min === null) {
      this.pos = start;
      return null;
    }
    let max = min;
    if (this.eat(",")) {
      const upper = this.readDecimal();
      max = upper === null ? Infinity : upper;
    }
    if (!this.eat("}")) {
      this.pos = start;
      return null;
    }
    return { min, max };
  }

  private readDecimal(): number | null {
    const start = this.pos;
    while (this.peek() >= "0" && this.peek() <= "9") this.pos++;
    if (this.pos === start) return null;
    return Number(this.src.slice(start, this.pos));
  }

  private parseAtom(): Node {
    const start = this.pos;
    const ch = this.peek();

    switch (ch) {
      case "^":
        this.pos++;
        return { type: "Assert", kind: "start" };
      case "$":
        this.pos++;
        return { type: "Assert", kind: "end" };
      case ".":
        this.pos++;
        return { type: "Char", set: this.dotAll ? cs.ANY : this.foldNegate(cs.LINE_TERMINATOR) };
      case "(":
        return this.parseGroup();
      case "[":
        return { type: "Char", set: this.parseClass() };
      case "\\":
        return this.parseEscape();
      case "*":
      case "+":
      case "?":
        this.fail(`nothing to repeat: '${ch}' has no preceding atom`, start);
        break;
      case ")":
        this.fail("unmatched ')'", start);
        break;
      case "]":
      case "}":
        this.fail(`lone '${ch}' (use '\\${ch}' to match it literally)`, start);
        break;
      case "{":
        this.fail("lone '{' (use '\\{' to match a literal brace)", start);
        break;
      default:
        break;
    }
    return { type: "Char", set: this.fold(cs.single(this.nextCodePoint())) };
  }

  private parseGroup(): Node {
    const start = this.pos;
    this.pos++; // '('

    let index: number | null = null;
    let name: string | null = null;

    if (this.eat("?")) {
      if (this.eat(":")) {
        // non-capturing
      } else if (this.peek() === "=" || this.peek() === "!") {
        this.unsupported(
          `lookahead '(?${this.peek()}' is not supported: it is not a regular ` +
            "operation, and dropping it is what buys the linear-time guarantee",
          start,
        );
      } else if (this.src.startsWith("<=", this.pos) || this.src.startsWith("<!", this.pos)) {
        this.unsupported(
          `lookbehind '(?${this.src.slice(this.pos, this.pos + 2)}' is not supported`,
          start,
        );
      } else if (this.eat("<")) {
        name = this.parseGroupName();
        if (this.groupNames.has(name)) this.fail(`duplicate capture group name '${name}'`, start);
        index = ++this.groupCount;
        this.groupNames.set(name, index);
      } else {
        this.fail("invalid group: expected '?:', '?<name>'", start);
      }
    } else {
      index = ++this.groupCount;
    }

    const body = this.parseAlternation();
    if (!this.eat(")")) this.fail("unterminated group: missing ')'", start);
    return { type: "Group", body, index, name };
  }

  private parseGroupName(): string {
    const start = this.pos;
    while (this.pos < this.src.length && this.peek() !== ">") this.pos++;
    if (this.pos >= this.src.length) this.fail("unterminated capture group name", start);
    const name = this.src.slice(start, this.pos);
    this.pos++; // '>'
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) {
      this.fail(`invalid capture group name '${name}'`, start);
    }
    return name;
  }

  /** An escape sequence in atom position (outside a character class). */
  private parseEscape(): Node {
    const start = this.pos;
    this.pos++; // '\'
    if (this.pos >= this.src.length) this.fail("trailing '\\' at end of pattern", start);
    const ch = this.peek();

    if (ch === "b") {
      this.pos++;
      return { type: "Assert", kind: "wordBoundary" };
    }
    if (ch === "B") {
      this.pos++;
      return { type: "Assert", kind: "notWordBoundary" };
    }
    if (ch === "k") {
      this.unsupported("named backreference '\\k' is not supported", start);
    }
    if (ch >= "1" && ch <= "9") {
      this.unsupported(
        `backreference '\\${ch}' is not supported: backreferences make matching ` +
          "NP-hard, which is precisely the class of pattern this engine excludes",
        start,
      );
    }
    const set = this.parseSetEscape(start);
    if (set !== null) return { type: "Char", set };

    const cp = this.parseCharacterEscape(start);
    if (cp === null) this.fail(`invalid escape '\\${ch}'`, start);
    return { type: "Char", set: this.fold(cs.single(cp)) };
  }

  /**
   * Escapes that denote a whole set of characters (`\\d`, `\\W`, ...). Shared by
   * atom and class position. Returns null when the escape denotes at most a
   * single code point, which the caller handles instead.
   */
  private parseSetEscape(start: number): CharSet | null {
    const ch = this.peek();
    switch (ch) {
      case "d":
        this.pos++;
        return this.fold(cs.DIGIT);
      case "D":
        this.pos++;
        return this.foldNegate(cs.DIGIT);
      case "w":
        this.pos++;
        return this.fold(cs.WORD);
      case "W":
        this.pos++;
        return this.foldNegate(cs.WORD);
      case "s":
        this.pos++;
        return this.fold(cs.SPACE);
      case "S":
        this.pos++;
        return this.foldNegate(cs.SPACE);
      case "p":
      case "P":
        this.unsupported(`Unicode property escape '\\${ch}{...}' is not supported yet`, start);
        break;
      default:
        break;
    }
    return null;
  }

  /** Escapes that denote a single code point. */
  private parseCharacterEscape(start: number): number | null {
    const ch = this.peek();
    switch (ch) {
      case "n":
        this.pos++;
        return 0x0a;
      case "r":
        this.pos++;
        return 0x0d;
      case "t":
        this.pos++;
        return 0x09;
      case "f":
        this.pos++;
        return 0x0c;
      case "v":
        this.pos++;
        return 0x0b;
      case "0": {
        this.pos++;
        const next = this.peek();
        if (next >= "0" && next <= "9") {
          this.fail("octal escapes are not allowed in Unicode mode", start);
        }
        return 0x00;
      }
      case "c": {
        const letter = this.peek(1);
        if (!/^[A-Za-z]$/u.test(letter)) this.fail("invalid control escape '\\c'", start);
        this.pos += 2;
        return letter.toUpperCase().charCodeAt(0) - 64;
      }
      case "x": {
        this.pos++;
        return this.readHex(2, start);
      }
      case "u": {
        this.pos++;
        if (this.eat("{")) {
          const digitStart = this.pos;
          while (/^[0-9a-fA-F]$/u.test(this.peek())) this.pos++;
          if (this.pos === digitStart) this.fail("invalid '\\u{...}' escape", start);
          const cp = Number.parseInt(this.src.slice(digitStart, this.pos), 16);
          if (!this.eat("}")) this.fail("unterminated '\\u{...}' escape", start);
          if (cp > cs.MAX_CODE_POINT) this.fail("code point out of range in '\\u{...}'", start);
          return cp;
        }
        return this.readHex(4, start);
      }
      default:
        break;
    }
    if (SYNTAX_CHARS.has(ch)) {
      this.pos++;
      return ch.codePointAt(0)!;
    }
    return null;
  }

  private readHex(digits: number, start: number): number {
    const text = this.src.slice(this.pos, this.pos + digits);
    if (text.length < digits || !/^[0-9a-fA-F]+$/u.test(text)) {
      this.fail(`invalid hexadecimal escape (expected ${digits} digits)`, start);
    }
    this.pos += digits;
    return Number.parseInt(text, 16);
  }

  // -- character classes --------------------------------------------------

  private parseClass(): CharSet {
    const start = this.pos;
    this.pos++; // '['
    const negated = this.eat("^");
    const pairs: number[] = [];
    const sets: CharSet[] = [];

    while (true) {
      if (this.pos >= this.src.length) this.fail("unterminated character class", start);
      if (this.eat("]")) break;

      const first = this.parseClassAtom();
      // A '-' directly before ']' is a literal, as is one after a set escape.
      if (this.peek() === "-" && this.peek(1) !== "]" && this.pos + 1 < this.src.length) {
        const dashAt = this.pos;
        this.pos++;
        const second = this.parseClassAtom();
        if (first.cp === null || second.cp === null) {
          this.fail("a character class escape cannot be a range endpoint", dashAt);
        }
        if (first.cp > second.cp) this.fail("character class range is out of order", dashAt);
        pairs.push(first.cp, second.cp);
        continue;
      }
      if (first.cp !== null) pairs.push(first.cp, first.cp);
      else sets.push(first.set);
    }

    // `sets` are already folded by parseSetEscape; the literal characters and
    // ranges are folded here. Negation comes last, on the folded union.
    const set = cs.union(this.fold(cs.normalize(pairs)), ...sets);
    return negated ? cs.negate(set) : set;
  }

  private parseClassAtom(): { cp: number | null; set: CharSet } {
    if (this.peek() === "\\") {
      const start = this.pos;
      this.pos++;
      if (this.pos >= this.src.length) this.fail("trailing '\\' at end of pattern", start);
      if (this.peek() === "b") {
        // Inside a class, \b is a backspace rather than a word boundary.
        this.pos++;
        return { cp: 0x08, set: cs.EMPTY };
      }
      if (this.peek() === "-") {
        this.pos++;
        return { cp: 0x2d, set: cs.EMPTY };
      }
      const single = this.peek();
      if (single >= "1" && single <= "9") {
        this.unsupported(`backreference '\\${single}' is not supported`, start);
      }
      // A set escape (\d, \W, ...) is not a valid range endpoint; a
      // single-code-point escape (\n, \x41, ...) is.
      const set = this.parseSetEscape(start);
      if (set !== null) return { cp: null, set };

      const cp = this.parseCharacterEscape(start);
      if (cp === null) this.fail(`invalid escape '\\${this.peek()}'`, start);
      return { cp, set: cs.EMPTY };
    }
    return { cp: this.nextCodePoint(), set: cs.EMPTY };
  }
}

export function parse(source: string, options: ParseOptions = {}): ParseResult {
  return new Parser(source, options).parse();
}
