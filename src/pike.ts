/**
 * The Pike VM: a Thompson NFA simulation that also tracks capture groups.
 *
 * Instead of backtracking, it advances a *set* of threads one input position
 * at a time. A thread is a program counter plus its capture slots, and the set
 * is deduplicated by program counter at every position — so at most `m`
 * threads can be alive at once and the whole match costs O(n * m), no matter
 * how ambiguous the pattern is. That bound is the entire point: patterns like
 * `(a+)+$` have no exponential path to explore here, because there is nothing
 * to explore.
 *
 * Threads are kept in priority order and a thread that reaches `Match` cuts
 * every lower-priority thread at that position, which reproduces the
 * leftmost-first (backtracking) semantics that JavaScript specifies for
 * greedy and lazy quantifiers.
 */

import { contains, LINE_TERMINATOR } from "./charset.ts";
import type { Input } from "./input.ts";
import type { AssertKind } from "./ast.ts";
import type { Inst, Program } from "./program.ts";
import { Op } from "./program.ts";

/** Capture slots as code point indices; -1 means "did not participate". */
export type Captures = Int32Array;

class ThreadList {
  readonly pcs: Int32Array;
  readonly caps: (Captures | null)[];
  size = 0;
  /** `mark[pc] === gen` means pc was already added at the current position. */
  private readonly mark: Int32Array;
  private gen = 0;

  constructor(programSize: number) {
    this.pcs = new Int32Array(programSize);
    this.caps = new Array(programSize).fill(null);
    this.mark = new Int32Array(programSize).fill(-1);
  }

  /** O(1) reset: bump the generation instead of clearing the mark array. */
  clear(): void {
    this.size = 0;
    this.gen++;
  }

  seen(pc: number): boolean {
    if (this.mark[pc] === this.gen) return true;
    this.mark[pc] = this.gen;
    return false;
  }

  push(pc: number, caps: Captures | null): void {
    this.pcs[this.size] = pc;
    this.caps[this.size] = caps;
    this.size++;
  }
}

export interface RunOptions {
  /** Code point index to start searching from. */
  readonly start: number;
  /** Anchor the match to `start` (the `y` flag). */
  readonly sticky: boolean;
  /** Track capture slots. Skipping them makes `test()` allocation-free. */
  readonly captures: boolean;
}

/**
 * Reusable per-program VM state. Allocating the thread lists once and reusing
 * them across calls keeps repeated `exec` loops (global matching) from
 * thrashing the allocator.
 */
export class PikeVM {
  /**
   * Instruction visits performed by the last `run`. The VM marks each program
   * counter at most once per input position per thread list, so this is
   * bounded by `3 * (n + 1) * programSize` no matter what the pattern looks
   * like. Tests assert that bound directly, which is a stronger statement than
   * any wall-clock measurement.
   */
  steps = 0;

  private readonly program: Program;
  private readonly insts: readonly Inst[];
  private readonly clist: ThreadList;
  private readonly nlist: ThreadList;
  private readonly stackPc: Int32Array;
  private readonly stackCaps: (Captures | null)[];
  private readonly slotCount: number;

  constructor(program: Program) {
    this.program = program;
    this.insts = program.insts;
    this.clist = new ThreadList(program.insts.length);
    this.nlist = new ThreadList(program.insts.length);
    this.stackPc = new Int32Array(program.insts.length + 1);
    this.stackCaps = new Array(program.insts.length + 1).fill(null);
    this.slotCount = (program.groupCount + 1) * 2;
  }

  /**
   * Returns the capture slots of the leftmost-first match (code point
   * indices), an empty array when `captures` is false and a match was found,
   * or null when there is no match.
   */
  run(input: Input, options: RunOptions): Captures | null {
    const { insts, program } = this;
    const { cps, length: n } = input;
    const anchored = options.sticky || program.anchoredStart;

    // A leading `^` outside multiline mode can only ever match at index 0.
    if (program.anchoredStart && options.start > 0) return null;

    let pos = Math.max(0, Math.min(options.start, n));
    let matched: Captures | null = null;
    this.steps = 0;

    this.clist.clear();
    this.nlist.clear();
    let clist = this.clist;
    let nlist = this.nlist;

    // `Save` and `Clear` copy before writing, so a single all-slots-unset
    // array can seed every start thread instead of one allocation per position.
    const initialCaps = options.captures ? new Int32Array(this.slotCount).fill(-1) : null;

    for (;;) {
      if (clist.size === 0) {
        if (matched !== null) break;
        if (anchored && pos > options.start) break;
        // Nothing alive: jump straight to the next plausible start.
        if (program.prefilter !== null && !anchored) {
          while (pos < n && !contains(program.prefilter, cps[pos])) pos++;
          // The prefilter only exists for patterns that must consume a
          // character, so a match cannot start at the end of the input.
          if (pos >= n) break;
        }
      }

      // A pattern that must consume a character can only start where that
      // character is possible, so most positions never spawn a thread at all.
      const canStart =
        program.prefilter === null || (pos < n && contains(program.prefilter, cps[pos]));
      if (matched === null && canStart && (!anchored || pos === options.start)) {
        this.addThread(clist, 0, initialCaps, pos, input);
      }

      if (clist.size === 0 && pos >= n) break;

      const cp = pos < n ? cps[pos] : -1;
      nlist.clear();

      for (let i = 0; i < clist.size; i++) {
        this.steps++;
        const pc = clist.pcs[i];
        const inst = insts[pc];
        if (inst.op === Op.Match) {
          matched = clist.caps[i] ?? EMPTY_CAPTURES;
          // Lower-priority threads lose: this is leftmost-first semantics.
          break;
        }
        if (inst.op === Op.Char && cp >= 0 && contains(inst.set, cp)) {
          this.addThread(nlist, pc + 1, clist.caps[i], pos + 1, input);
        }
      }

      const swap = clist;
      clist = nlist;
      nlist = swap;

      if (pos >= n) break;
      pos++;
    }

    return matched;
  }

  /**
   * Follow every epsilon transition reachable from `pc` and record the threads
   * that stop on a `Char` or `Match`. Explicit stack rather than recursion:
   * an epsilon chain can be as long as the program itself.
   */
  private addThread(
    list: ThreadList,
    pc0: number,
    caps0: Captures | null,
    pos: number,
    input: Input,
  ): void {
    const { insts, stackPc, stackCaps } = this;
    let top = 0;
    stackPc[top] = pc0;
    stackCaps[top] = caps0;
    top++;

    while (top > 0) {
      top--;
      const pc = stackPc[top];
      const caps = stackCaps[top];
      if (list.seen(pc)) continue;
      this.steps++;

      const inst = insts[pc];
      switch (inst.op) {
        case Op.Jmp:
          stackPc[top] = inst.x;
          stackCaps[top] = caps;
          top++;
          break;
        case Op.Split:
          // Push the low-priority branch first so the high-priority branch is
          // popped (and therefore explored) first.
          stackPc[top] = inst.y;
          stackCaps[top] = caps;
          top++;
          stackPc[top] = inst.x;
          stackCaps[top] = caps;
          top++;
          break;
        case Op.Save: {
          let next = caps;
          if (caps !== null) {
            next = caps.slice();
            next[inst.slot] = pos;
          }
          stackPc[top] = pc + 1;
          stackCaps[top] = next;
          top++;
          break;
        }
        case Op.Clear: {
          let next = caps;
          if (caps !== null) {
            next = caps.slice();
            next.fill(-1, inst.from, inst.to + 1);
          }
          stackPc[top] = pc + 1;
          stackCaps[top] = next;
          top++;
          break;
        }
        case Op.Assert:
          if (this.satisfied(inst.kind, pos, input)) {
            stackPc[top] = pc + 1;
            stackCaps[top] = caps;
            top++;
          }
          break;
        default:
          list.push(pc, caps);
          break;
      }
    }
  }

  private satisfied(kind: AssertKind, pos: number, input: Input): boolean {
    const { cps, length: n } = input;
    const multiline = this.program.multiline;
    switch (kind) {
      case "start":
        return pos === 0 || (multiline && contains(LINE_TERMINATOR, cps[pos - 1]));
      case "end":
        return pos === n || (multiline && contains(LINE_TERMINATOR, cps[pos]));
      case "wordBoundary":
      case "notWordBoundary": {
        const word = this.program.wordSet;
        const before = pos > 0 && contains(word, cps[pos - 1]);
        const after = pos < n && contains(word, cps[pos]);
        const boundary = before !== after;
        return kind === "wordBoundary" ? boundary : !boundary;
      }
    }
  }
}

const EMPTY_CAPTURES: Captures = new Int32Array(0);
