import assert from "node:assert/strict";
import test from "node:test";

import { SafeRegExp, re } from "../src/index.ts";

const exec = (source: string, flags: string, input: string) => {
  const m = new SafeRegExp(source, flags).exec(input);
  return m === null ? null : { index: m.index, groups: Array.from(m) };
};

test("literals, classes and anchors", () => {
  assert.deepEqual(exec("abc", "", "xxabcxx"), { index: 2, groups: ["abc"] });
  assert.deepEqual(exec("^abc$", "", "abc"), { index: 0, groups: ["abc"] });
  assert.equal(exec("^abc$", "", "xabc"), null);
  assert.deepEqual(exec("[^a-z]+", "", "abc123"), { index: 3, groups: ["123"] });
  assert.deepEqual(exec("a.c", "", "a\nc"), null);
  assert.deepEqual(exec("a.c", "s", "a\nc"), { index: 0, groups: ["a\nc"] });
});

test("greedy and lazy quantifiers pick different matches", () => {
  assert.deepEqual(exec("<.+>", "", "<a><b>"), { index: 0, groups: ["<a><b>"] });
  assert.deepEqual(exec("<.+?>", "", "<a><b>"), { index: 0, groups: ["<a>"] });
  assert.deepEqual(exec("a{2,4}", "", "aaaaa"), { index: 0, groups: ["aaaa"] });
  assert.deepEqual(exec("a{2,4}?", "", "aaaaa"), { index: 0, groups: ["aa"] });
  assert.deepEqual(exec("a{3,}", "", "aaaaa"), { index: 0, groups: ["aaaaa"] });
});

test("capture groups and named groups", () => {
  const m = new SafeRegExp("(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})").exec("on 2026-09-09");
  assert.ok(m);
  assert.equal(m.index, 3);
  assert.deepEqual(Array.from(m), ["2026-09-09", "2026", "09", "09"]);
  assert.deepEqual({ ...m.groups }, { year: "2026", month: "09", day: "09" });
});

test("a group that did not participate is undefined", () => {
  const m = new SafeRegExp("(a)|(b)").exec("b");
  assert.deepEqual(Array.from(m!), ["b", undefined, "b"]);
});

test("captures are reset on each iteration, as ECMAScript requires", () => {
  assert.deepEqual(exec("(?:(a)|b){2}", "", "ab"), { index: 0, groups: ["ab", undefined] });
  assert.deepEqual(exec("(?:(a)|b){2}", "", "ba"), { index: 0, groups: ["ba", "a"] });
});

test("the d flag reports match indices", () => {
  const m = new SafeRegExp("(\\w+)@(?<host>\\w+)", "d").exec("mail: me@example");
  assert.ok(m?.indices);
  assert.deepEqual(m.indices[0], [6, 16]);
  assert.deepEqual(m.indices[1], [6, 8]);
  assert.deepEqual(m.indices.groups!.host, [9, 16]);
});

test("case-insensitive matching folds before negating", () => {
  assert.equal(re("[^ab]", "i").test("A"), false);
  assert.equal(re("[a-z]", "i").test("K"), true); // U+212A KELVIN SIGN
  assert.equal(re("\\w", "i").test("ſ"), true); // LATIN SMALL LETTER LONG S
  assert.equal(re("\\W", "i").test("ſ"), false);
  assert.equal(re("ß", "i").test("ẞ"), true); // ß / capital ẞ
  assert.equal(re("i", "i").test("ı"), false); // dotless i is excluded from folding
});

test("multiline changes the meaning of the anchors", () => {
  assert.deepEqual(exec("^b", "", "a\nb"), null);
  assert.deepEqual(exec("^b", "m", "a\nb"), { index: 2, groups: ["b"] });
  assert.deepEqual(exec("a$", "m", "a\nb"), { index: 0, groups: ["a"] });
});

test("word boundaries", () => {
  assert.deepEqual(exec("\\bcat\\b", "", "a cat here"), { index: 2, groups: ["cat"] });
  assert.equal(exec("\\bcat\\b", "", "concatenate"), null);
  assert.deepEqual(exec("\\Bcat", "", "concat"), { index: 3, groups: ["cat"] });
});

test("astral characters are matched as single code points", () => {
  assert.deepEqual(exec(".", "", "\u{1f600}b"), { index: 0, groups: ["\u{1f600}"] });
  assert.deepEqual(exec("^.$", "", "\u{1f600}"), { index: 0, groups: ["\u{1f600}"] });
  assert.deepEqual(exec("\u{1f600}+", "", "x\u{1f600}\u{1f600}"), {
    index: 1,
    groups: ["\u{1f600}\u{1f600}"],
  });
  // Indices stay in UTF-16 units so they line up with String methods.
  assert.deepEqual(exec("b", "", "\u{1f600}b"), { index: 2, groups: ["b"] });
});

test("lastIndex protocol for the g and y flags", () => {
  const g = new SafeRegExp("a", "g");
  assert.equal(g.exec("banana")!.index, 1);
  assert.equal(g.lastIndex, 2);
  assert.equal(g.exec("banana")!.index, 3);
  assert.equal(g.exec("banana")!.index, 5);
  assert.equal(g.exec("banana"), null);
  assert.equal(g.lastIndex, 0);

  const sticky = new SafeRegExp("a", "y");
  sticky.lastIndex = 1;
  assert.equal(sticky.exec("banana")!.index, 1);
  sticky.lastIndex = 2;
  assert.equal(sticky.exec("banana"), null);
});

test("a leading ^ cannot match at a later position", () => {
  const anchored = new SafeRegExp("^a", "g");
  anchored.lastIndex = 1;
  assert.equal(anchored.exec("aaa"), null);
});

test("matchAll advances past empty matches", () => {
  const found = [...new SafeRegExp("a*", "g").matchAll("aab")];
  assert.deepEqual(
    found.map((m) => [m.index, m[0]]),
    [
      [0, "aa"],
      [2, ""],
      [3, ""],
    ],
  );
});

test("works with the String methods through the well-known symbols", () => {
  assert.equal("2026-09-09".replace(new SafeRegExp("(\\d+)-(\\d+)-(\\d+)"), "$3/$2/$1"), "09/09/2026");
  assert.equal("a1b2".replace(new SafeRegExp("\\d", "g"), (d: string) => `[${d}]`), "a[1]b[2]");
  assert.equal(
    "me@example".replace(new SafeRegExp("(?<user>\\w+)@"), "$<user> at "),
    "me at example",
  );
  assert.deepEqual("a1b22c".split(new SafeRegExp("\\d+", "g")), ["a", "b", "c"]);
  assert.deepEqual("a1b".split(new SafeRegExp("(\\d)", "g")), ["a", "1", "b"]);
  assert.deepEqual("banana".match(new SafeRegExp("[aeiou]", "g")), ["a", "a", "a"]);
  assert.equal("xyz".match(new SafeRegExp("[aeiou]", "g")), null);
  assert.equal("xxabc".search(new SafeRegExp("abc")), 2);
  // String.prototype.matchAll dispatches on Symbol.matchAll at runtime, but its
  // TypeScript signature only accepts a RegExp, so the cast is a lib limitation
  // rather than an engine one.
  const matcher = new SafeRegExp("\\d", "g") as unknown as RegExp;
  assert.deepEqual([..."a1b2".matchAll(matcher)].map((m) => m[0]), ["1", "2"]);
});

test("replacement patterns", () => {
  const dollar = new SafeRegExp("b");
  assert.equal("abc".replace(dollar, "$$"), "a$c");
  assert.equal("abc".replace(dollar, "$&$&"), "abbc");
  assert.equal("abc".replace(dollar, "[$`|$']"), "a[a|c]c");
});

test("escape() makes a literal safe to embed", () => {
  const literal = "1 + 1 = 2? [yes]";
  assert.equal(new SafeRegExp(SafeRegExp.escape(literal)).test(literal), true);
  assert.equal(new SafeRegExp(SafeRegExp.escape(literal)).test("1 X 1 = 2? [yes]"), false);
});

test("flag validation", () => {
  assert.throws(() => new SafeRegExp("a", "gg"), /duplicate flag/u);
  assert.throws(() => new SafeRegExp("a", "v"), /unsupported flag/u);
  assert.doesNotThrow(() => new SafeRegExp("a", "u")); // Unicode mode is always on
});

test("toString round-trips the pattern", () => {
  assert.equal(String(new SafeRegExp("a+b", "gi")), "/a+b/gi");
});
