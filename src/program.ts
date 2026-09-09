import type { CharSet } from "./charset.ts";
import type { AssertKind } from "./ast.ts";

/**
 * The compiled form is a flat instruction array, executed by the Pike VM as a
 * set of NFA threads rather than by backtracking. `Split` is the only
 * branching instruction: it forks the thread set, with `x` taking priority
 * over `y`, and that priority is what encodes greedy vs. lazy matching.
 */
export const Op = {
  Char: 0,
  Split: 1,
  Jmp: 2,
  Save: 3,
  Assert: 4,
  Match: 5,
  Clear: 6,
} as const;

export type OpCode = (typeof Op)[keyof typeof Op];

export type Inst =
  | { op: typeof Op.Char; set: CharSet }
  | { op: typeof Op.Split; x: number; y: number }
  | { op: typeof Op.Jmp; x: number }
  | { op: typeof Op.Save; slot: number }
  | { op: typeof Op.Assert; kind: AssertKind }
  | { op: typeof Op.Match }
  /** Reset capture slots `from`..`to` (inclusive) to "did not participate". */
  | { op: typeof Op.Clear; from: number; to: number };

export interface Program {
  readonly insts: readonly Inst[];
  /** Number of capture groups, excluding the implicit whole-match group. */
  readonly groupCount: number;
  readonly groupNames: ReadonlyMap<string, number>;
  /** Code points that can start a match, or null when any point can. */
  readonly prefilter: CharSet | null;
  /** True when every match must begin at the search start (a leading `^`). */
  readonly anchoredStart: boolean;
  /** `^` and `$` also match at line boundaries. */
  readonly multiline: boolean;
  /**
   * The set `\b` treats as word characters. Under the `i` flag ECMAScript
   * widens it by case folding, so `\b` sits before U+017F LATIN SMALL LETTER
   * LONG S exactly as it sits before `s`.
   */
  readonly wordSet: CharSet;
}

/** Human-readable disassembly, handy when debugging a pattern. */
export function disassemble(program: Program): string {
  return program.insts
    .map((inst, pc) => {
      const label = String(pc).padStart(3, "0");
      switch (inst.op) {
        case Op.Char: {
          const ranges = [];
          for (let i = 0; i < inst.set.length; i += 2) {
            ranges.push(
              inst.set[i] === inst.set[i + 1]
                ? hex(inst.set[i])
                : `${hex(inst.set[i])}-${hex(inst.set[i + 1])}`,
            );
          }
          const body = ranges.length > 6 ? `${ranges.slice(0, 6).join(",")},…` : ranges.join(",");
          return `${label}  char   [${body}]`;
        }
        case Op.Split:
          return `${label}  split  ${inst.x}, ${inst.y}`;
        case Op.Jmp:
          return `${label}  jmp    ${inst.x}`;
        case Op.Save:
          return `${label}  save   ${inst.slot}`;
        case Op.Assert:
          return `${label}  assert ${inst.kind}`;
        case Op.Match:
          return `${label}  match`;
        case Op.Clear:
          return `${label}  clear  ${inst.from}..${inst.to}`;
      }
    })
    .join("\n");
}

function hex(cp: number): string {
  const ch = String.fromCodePoint(cp);
  return cp >= 0x20 && cp < 0x7f ? ch : `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}
