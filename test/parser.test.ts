import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "../src/parser.ts";
import { RegexSyntaxError, UnsupportedPatternError } from "../src/errors.ts";
import { SafeRegExp } from "../src/index.ts";

test("builds the expected shape", () => {
  assert.deepEqual(parse("a|b").node, {
    type: "Alt",
    options: [
      { type: "Char", set: [97, 97] },
      { type: "Char", set: [98, 98] },
    ],
  });
  assert.deepEqual(parse("a{2,3}?").node, {
    type: "Repeat",
    body: { type: "Char", set: [97, 97] },
    min: 2,
    max: 3,
    greedy: false,
  });
});

test("counts and names capture groups", () => {
  const result = parse("(a)(?:b)(?<c>c)");
  assert.equal(result.groupCount, 2);
  assert.deepEqual([...result.groupNames], [["c", 2]]);
});

test("character classes fold into normalized ranges", () => {
  assert.deepEqual(parse("[a-cb-e]").node, { type: "Char", set: [97, 101] });
  assert.deepEqual(parse("[\\d_]").node, { type: "Char", set: [48, 57, 95, 95] });
});

const SYNTAX_ERRORS: readonly [string, RegExp][] = [
  ["a**", /quantifier cannot follow another quantifier/u],
  ["*a", /nothing to repeat/u],
  ["^*", /cannot follow an assertion/u],
  ["(a", /unterminated group/u],
  ["a)", /unmatched '\)'/u],
  ["[a", /unterminated character class/u],
  ["[z-a]", /out of order/u],
  ["a{3,1}", /out of order/u],
  ["a{", /lone '\{'/u],
  ["]", /lone '\]'/u],
  ["\\", /trailing '\\'/u],
  ["\\q", /invalid escape/u],
  ["\\x2", /invalid hexadecimal escape/u],
  ["\\u{110000}", /out of range/u],
  ["[\\d-z]", /cannot be a range endpoint/u],
  ["(?<1a>x)", /invalid capture group name/u],
  ["(?<a>x)(?<a>y)", /duplicate capture group name/u],
  ["(?#comment)", /invalid group/u],
];

test("rejects invalid syntax with a located message", () => {
  for (const [source, message] of SYNTAX_ERRORS) {
    assert.throws(
      () => parse(source),
      (error: unknown) => {
        assert.ok(error instanceof RegexSyntaxError, `${source}: wrong error type`);
        assert.match(error.message, message, `${source}: unexpected message`);
        assert.ok(error.index >= -1 && error.index <= source.length, `${source}: bad index`);
        return true;
      },
      source,
    );
  }
});

test("rejects constructs that are not regular, and says why", () => {
  for (const source of ["(?=a)", "(?!a)", "(?<=a)", "(?<!a)", "(a)\\1", "\\k<x>", "\\p{L}"]) {
    assert.throws(() => parse(source), UnsupportedPatternError, source);
  }
});

test("errors point at the offending character", () => {
  let error: RegexSyntaxError | null = null;
  try {
    parse("ab(cd");
  } catch (caught) {
    error = caught as RegexSyntaxError;
  }
  assert.ok(error instanceof RegexSyntaxError);
  assert.equal(error.index, 2);
  assert.deepEqual(error.format().split("\n").slice(1), ["  /ab(cd/", "     ^"]);
});

test("every pattern the native engine accepts is either accepted or explained", () => {
  // A crude but useful invariant: we never report a syntax error for a pattern
  // the platform considers valid, we only report it as unsupported.
  const patterns = ["a|b", "[\\s\\S]", "(?:x)+?", "a{0,}", "\\u{1f600}", "[^]", "\\cA", "\\0"];
  for (const source of patterns) {
    new RegExp(source, "u"); // throws here if the sample itself is bad
    try {
      new SafeRegExp(source);
    } catch (error) {
      assert.ok(error instanceof UnsupportedPatternError, `${source}: ${String(error)}`);
    }
  }
});
