import type { CharSet } from "./charset.ts";

export type AssertKind = "start" | "end" | "wordBoundary" | "notWordBoundary";

export type Node =
  /** Matches the empty string. */
  | { readonly type: "Empty" }
  /** Consumes exactly one code point drawn from `set`. */
  | { readonly type: "Char"; readonly set: CharSet }
  /** Zero-width assertion. */
  | { readonly type: "Assert"; readonly kind: AssertKind }
  | { readonly type: "Concat"; readonly body: readonly Node[] }
  | { readonly type: "Alt"; readonly options: readonly Node[] }
  /** `max` is `Infinity` for unbounded repeats. */
  | {
      readonly type: "Repeat";
      readonly body: Node;
      readonly min: number;
      readonly max: number;
      readonly greedy: boolean;
    }
  /** `index` is null for non-capturing groups. */
  | {
      readonly type: "Group";
      readonly body: Node;
      readonly index: number | null;
      readonly name: string | null;
    };

/** Result of parsing, including the capture group table. */
export interface ParseResult {
  readonly node: Node;
  readonly groupCount: number;
  readonly groupNames: ReadonlyMap<string, number>;
}
