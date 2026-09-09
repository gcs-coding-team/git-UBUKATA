/**
 * Thompson construction: the AST is lowered to a flat NFA program.
 *
 * Every node compiles to a contiguous block of instructions that falls through
 * to whatever follows it, so concatenation needs no glue at all and the only
 * patching required is for the forward branches of `split`/`jmp`.
 */

import type { Node } from "./ast.ts";
import type { CharSet } from "./charset.ts";
import * as cs from "./charset.ts";
import { foldSet } from "./casefold.ts";
import { RegexCompileError } from "./errors.ts";
import { parse } from "./parser.ts";
import type { Inst, Program } from "./program.ts";
import { Op } from "./program.ts";

export interface CompileOptions {
  readonly ignoreCase?: boolean;
  readonly dotAll?: boolean;
  readonly multiline?: boolean;
  /**
   * Upper bound on the compiled program. Bounded repeats such as
   * `(?:ab){1000}` are expanded, so this caps the memory a pattern can claim.
   */
  readonly maxProgramSize?: number;
}

const DEFAULT_MAX_PROGRAM_SIZE = 200_000;

class Compiler {
  private readonly insts: Inst[] = [];
  private readonly source: string;
  private readonly maxSize: number;

  constructor(source: string, options: CompileOptions) {
    this.source = source;
    this.maxSize = options.maxProgramSize ?? DEFAULT_MAX_PROGRAM_SIZE;
  }

  private emit(inst: Inst): number {
    if (this.insts.length >= this.maxSize) {
      throw new RegexCompileError(
        `pattern expands to more than ${this.maxSize} instructions; ` +
          "reduce the bounded repetition counts",
        this.source,
        -1,
      );
    }
    this.insts.push(inst);
    return this.insts.length - 1;
  }

  private here(): number {
    return this.insts.length;
  }

  /** Fill in a forward branch target once its destination is known. */
  private patch(pc: number, field: "x" | "y", target: number): void {
    const inst = this.insts[pc];
    if (inst.op === Op.Split) {
      if (field === "x") inst.x = target;
      else inst.y = target;
      return;
    }
    if (inst.op === Op.Jmp && field === "x") {
      inst.x = target;
      return;
    }
    throw new Error(`compiler bug: cannot patch '${field}' of instruction ${pc}`);
  }

  compile(node: Node): Inst[] {
    this.emit({ op: Op.Save, slot: 0 });
    this.node(node);
    this.emit({ op: Op.Save, slot: 1 });
    this.emit({ op: Op.Match });
    return this.insts;
  }

  private node(node: Node): void {
    switch (node.type) {
      case "Empty":
        return;

      case "Char":
        // Sets are folded during parsing, where the pre-negation set is still
        // available, so nothing is left to do here.
        this.emit({ op: Op.Char, set: node.set });
        return;

      case "Assert":
        this.emit({ op: Op.Assert, kind: node.kind });
        return;

      case "Concat":
        for (const child of node.body) this.node(child);
        return;

      case "Alt": {
        // split -> option, else next split; every option jumps to the end.
        const exits: number[] = [];
        for (let i = 0; i < node.options.length - 1; i++) {
          const split = this.emit({ op: Op.Split, x: 0, y: 0 });
          this.patch(split, "x", this.here());
          this.node(node.options[i]);
          exits.push(this.emit({ op: Op.Jmp, x: 0 }));
          this.patch(split, "y", this.here());
        }
        this.node(node.options[node.options.length - 1]);
        const end = this.here();
        for (const pc of exits) this.patch(pc, "x", end);
        return;
      }

      case "Group": {
        if (node.index === null) {
          this.node(node.body);
          return;
        }
        this.emit({ op: Op.Save, slot: node.index * 2 });
        this.node(node.body);
        this.emit({ op: Op.Save, slot: node.index * 2 + 1 });
        return;
      }

      case "Repeat":
        this.repeat(node.body, node.min, node.max, node.greedy);
        return;
    }
  }

  private repeat(body: Node, min: number, max: number, greedy: boolean): void {
    if (max === 0) return;

    if (max === Infinity) {
      for (let i = 0; i < min; i++) {
        if (i === min - 1) {
          this.plus(body, greedy); // the last mandatory copy carries the loop
          return;
        }
        this.iteration(body);
      }
      this.star(body, greedy);
      return;
    }

    for (let i = 0; i < min; i++) this.iteration(body);
    this.optionals(body, max - min, greedy);
  }

  /**
   * One iteration of a quantified body.
   *
   * ECMAScript resets every capture group inside a quantified body at the
   * start of each iteration, so `/(?:(a)|b){2}/.exec("ab")` leaves group 1
   * undefined rather than "a". Most NFA engines skip this; here it is one
   * extra epsilon instruction, which keeps the linear-time bound intact.
   */
  private iteration(body: Node): void {
    const range = groupRange(body);
    if (range !== null) {
      this.emit({ op: Op.Clear, from: range.min * 2, to: range.max * 2 + 1 });
    }
    this.node(body);
  }

  /** `body*` */
  private star(body: Node, greedy: boolean): void {
    const top = this.here();
    const split = this.emit({ op: Op.Split, x: 0, y: 0 });
    this.patch(split, greedy ? "x" : "y", this.here());
    this.iteration(body);
    this.emit({ op: Op.Jmp, x: top });
    this.patch(split, greedy ? "y" : "x", this.here());
  }

  /** `body+` */
  private plus(body: Node, greedy: boolean): void {
    const top = this.here();
    this.iteration(body);
    const split = this.emit({ op: Op.Split, x: 0, y: 0 });
    this.patch(split, greedy ? "x" : "y", top);
    this.patch(split, greedy ? "y" : "x", this.here());
  }

  /**
   * `count` nested optional copies: `x{2,4}` becomes `xx(?:x(?:x)?)?`.
   * Nesting (rather than a flat `x?x?`) keeps the thread priority order equal
   * to what a backtracking engine would explore.
   */
  private optionals(body: Node, count: number, greedy: boolean): void {
    const splits: number[] = [];
    for (let i = 0; i < count; i++) {
      const split = this.emit({ op: Op.Split, x: 0, y: 0 });
      splits.push(split);
      this.patch(split, greedy ? "x" : "y", this.here());
      this.iteration(body);
    }
    const end = this.here();
    for (const pc of splits) this.patch(pc, greedy ? "y" : "x", end);
  }
}

// ---------------------------------------------------------------------------
// Static analysis used to skip impossible starting positions
// ---------------------------------------------------------------------------

/** Lowest and highest capture group index inside a subtree, if any. */
function groupRange(node: Node): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  const visit = (n: Node): void => {
    switch (n.type) {
      case "Group":
        if (n.index !== null) {
          min = Math.min(min, n.index);
          max = Math.max(max, n.index);
        }
        visit(n.body);
        return;
      case "Concat":
        n.body.forEach(visit);
        return;
      case "Alt":
        n.options.forEach(visit);
        return;
      case "Repeat":
        visit(n.body);
        return;
      default:
        return;
    }
  };
  visit(node);
  return max < 0 ? null : { min, max };
}

interface First {
  set: CharSet;
  nullable: boolean;
}

function firstSet(node: Node): First {
  switch (node.type) {
    case "Empty":
      return { set: cs.EMPTY, nullable: true };
    case "Char":
      return { set: node.set, nullable: false };
    case "Assert":
      return { set: cs.EMPTY, nullable: true };
    case "Group":
      return firstSet(node.body);
    case "Concat": {
      let set: CharSet = cs.EMPTY;
      for (const child of node.body) {
        const f = firstSet(child);
        set = cs.union(set, f.set);
        if (!f.nullable) return { set, nullable: false };
      }
      return { set, nullable: true };
    }
    case "Alt": {
      let set: CharSet = cs.EMPTY;
      let nullable = false;
      for (const option of node.options) {
        const f = firstSet(option);
        set = cs.union(set, f.set);
        nullable ||= f.nullable;
      }
      return { set, nullable };
    }
    case "Repeat": {
      const f = firstSet(node.body);
      return { set: f.set, nullable: node.min === 0 || f.nullable };
    }
  }
}

/** True when every alternative starts with `^`. */
function startsAnchored(node: Node): boolean {
  switch (node.type) {
    case "Assert":
      return node.kind === "start";
    case "Group":
      return startsAnchored(node.body);
    case "Concat":
      for (const child of node.body) {
        if (startsAnchored(child)) return true;
        const f = firstSet(child);
        if (!f.nullable) return false;
      }
      return false;
    case "Alt":
      return node.options.every(startsAnchored);
    case "Repeat":
      return node.min > 0 && startsAnchored(node.body);
    default:
      return false;
  }
}

export function compile(source: string, options: CompileOptions = {}): Program {
  const { node, groupCount, groupNames } = parse(source, {
    dotAll: options.dotAll,
    ignoreCase: options.ignoreCase,
  });
  const insts = new Compiler(source, options).compile(node);

  const first = firstSet(node);
  // A nullable pattern can match anywhere, so there is nothing to skip.
  const prefilter = first.nullable || cs.isEmpty(first.set) ? null : first.set;

  return {
    insts,
    groupCount,
    groupNames,
    prefilter,
    anchoredStart: !options.multiline && startsAnchored(node),
    multiline: options.multiline ?? false,
    wordSet: options.ignoreCase ? foldSet(cs.WORD) : cs.WORD,
  };
}
