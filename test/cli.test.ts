import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/resafe.ts", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "resafe-"));
const sample = join(dir, "sample.txt");
writeFileSync(sample, "alpha 2026-09-09\nbeta nothing here\ngamma 1999-12-31\n");

function run(args: readonly string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { stdout, status: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: (failure.stdout ?? "") + (failure.stderr ?? ""), status: failure.status ?? -1 };
  }
}

test("prints matching lines with numbers", () => {
  const { stdout, status } = run(["-n", "\\d{4}-\\d\\d-\\d\\d", sample]);
  assert.equal(status, 0);
  assert.deepEqual(stdout.trimEnd().split("\n"), ["1:alpha 2026-09-09", "3:gamma 1999-12-31"]);
});

test("only-matching, count and invert", () => {
  assert.equal(run(["-o", "\\d{4}", sample]).stdout, "2026\n1999\n");
  assert.equal(run(["-c", "a", sample]).stdout, "3\n");
  assert.equal(run(["-v", "\\d", sample]).stdout, "beta nothing here\n");
});

test("exit status follows grep conventions", () => {
  assert.equal(run(["alpha", sample]).status, 0);
  assert.equal(run(["nowhere-to-be-found", sample]).status, 1);
  assert.equal(run(["(?=x)", sample]).status, 2);
  assert.equal(run(["a", join(dir, "missing.txt")]).status, 2);
});

test("reports unsupported syntax with a caret", () => {
  const { stdout } = run(["ab(?=c)", sample]);
  assert.match(stdout, /lookahead/u);
  assert.match(stdout, /\n {5}\^\n?$/u); // caret under the '(' at index 2
});

test("--explain disassembles the compiled program", () => {
  const { stdout } = run(["--explain", "a+b"]);
  assert.match(stdout, /save {3}0/u);
  assert.match(stdout, /split/u);
  assert.match(stdout, /match/u);
});

test("a catastrophic pattern does not hang the CLI", () => {
  const evil = join(dir, "evil.txt");
  writeFileSync(evil, `${"a".repeat(200)}!\n`);
  const started = Date.now();
  assert.equal(run(["(a+)+$", evil]).status, 1);
  assert.ok(Date.now() - started < 10_000, "CLI took too long");
});
