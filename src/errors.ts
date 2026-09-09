/** Base class for every error this engine raises while building a pattern. */
export class RegexError extends Error {
  readonly source: string;
  /** Offset into `source` where the problem was detected, or -1. */
  readonly index: number;

  constructor(message: string, source: string, index: number) {
    super(message);
    this.name = new.target.name;
    this.source = source;
    this.index = index;
  }

  /** Render the pattern with a caret under the offending position. */
  format(): string {
    if (this.index < 0) return `${this.name}: ${this.message}`;
    return [
      `${this.name}: ${this.message}`,
      `  /${this.source}/`,
      `  ${" ".repeat(this.index + 1)}^`,
    ].join("\n");
  }
}

/** The pattern is not valid syntax. */
export class RegexSyntaxError extends RegexError {}

/**
 * The pattern is valid regexp syntax but describes something outside the
 * regular languages (backreferences, lookaround), which is exactly the
 * expressive power this engine trades away for its linear-time guarantee.
 */
export class UnsupportedPatternError extends RegexError {}

/** The pattern is supported but compiles to a program beyond the size budget. */
export class RegexCompileError extends RegexError {}
