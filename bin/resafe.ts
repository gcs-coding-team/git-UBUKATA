#!/usr/bin/env -S node --experimental-strip-types
/**
 * A small grep built on the engine, mostly so the linear-time guarantee is
 * something you can point at:
 *
 *   resafe '(a+)+$' hugefile.txt     # finishes; a backtracking grep may not
 *   resafe --explain '(\d{4})-(\d\d)'
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { RegexError, SafeRegExp, disassemble } from "../src/index.ts";
import type { SafeMatchArray } from "../src/index.ts";

const USAGE = `usage: resafe [options] <pattern> [file...]

Searches each file (or standard input) for lines matching a pattern.

options:
  -i, --ignore-case     case-insensitive matching
  -n, --line-number     prefix each line with its line number
  -c, --count           print only the number of matching lines
  -o, --only-matching   print only the matched parts, one per line
  -v, --invert-match    select the lines that do not match
  -H, --with-filename   prefix each line with the file name
      --explain         print the compiled program instead of searching
      --no-color        never colourise matches
  -h, --help            show this message

Patterns use JavaScript regexp syntax without backreferences or lookaround;
those are rejected up front, which is what keeps matching linear-time.`;

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "ignore-case": { type: "boolean", short: "i", default: false },
        "line-number": { type: "boolean", short: "n", default: false },
        count: { type: "boolean", short: "c", default: false },
        "only-matching": { type: "boolean", short: "o", default: false },
        "invert-match": { type: "boolean", short: "v", default: false },
        "with-filename": { type: "boolean", short: "H", default: false },
        explain: { type: "boolean", default: false },
        "no-color": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`resafe: ${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }

  const { values: flags, positionals } = parsed;
  if (flags.help || positionals.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return positionals.length === 0 && !flags.help ? 2 : 0;
  }

  const [source, ...files] = positionals;
  let regex: SafeRegExp;
  try {
    regex = new SafeRegExp(source, flags["ignore-case"] ? "gi" : "g");
  } catch (error) {
    if (error instanceof RegexError) {
      process.stderr.write(`resafe: ${error.format()}\n`);
      return 2;
    }
    throw error;
  }

  if (flags.explain) {
    process.stdout.write(`${disassemble(regex.compiled)}\n`);
    return 0;
  }

  const colorize =
    !flags["no-color"] && process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
  const showName = flags["with-filename"] || files.length > 1;
  const sources = files.length > 0 ? files : ["-"];

  let matchedAnything = false;
  let status = 0;
  const out: string[] = [];

  for (const file of sources) {
    let text: string;
    try {
      text = readFileSync(file === "-" ? 0 : file, "utf8");
    } catch (error) {
      process.stderr.write(`resafe: ${file}: ${(error as NodeJS.ErrnoException).code ?? "error"}\n`);
      status = 2;
      continue;
    }

    const label = file === "-" ? "(standard input)" : file;
    let count = 0;
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();

    for (const [index, line] of lines.entries()) {
      const matches = [...regex.matchAll(line)];
      const selected = flags["invert-match"] ? matches.length === 0 : matches.length > 0;
      if (!selected) continue;
      count++;
      matchedAnything = true;
      if (flags.count) continue;

      const prefix = (showName ? `${label}:` : "") + (flags["line-number"] ? `${index + 1}:` : "");
      if (flags["only-matching"] && !flags["invert-match"]) {
        for (const m of matches) out.push(prefix + (colorize ? red(m[0]) : m[0]));
      } else {
        out.push(prefix + (colorize && !flags["invert-match"] ? highlight(line, matches) : line));
      }
    }

    if (flags.count) out.push((showName ? `${label}:` : "") + String(count));
  }

  if (out.length > 0) process.stdout.write(`${out.join("\n")}\n`);
  return status !== 0 ? status : matchedAnything ? 0 : 1;
}

const RED = "\u001b[1;31m";
const RESET = "\u001b[0m";

function red(text: string): string {
  return `${RED}${text}${RESET}`;
}

function highlight(line: string, matches: readonly SafeMatchArray[]): string {
  let out = "";
  let position = 0;
  for (const m of matches) {
    if (m[0].length === 0) continue;
    out += line.slice(position, m.index) + red(m[0]);
    position = m.index + m[0].length;
  }
  return out + line.slice(position);
}

process.exitCode = main(process.argv.slice(2));
