/**
 * The VM steps over code points, but every index it hands back has to be a
 * UTF-16 offset so that results line up with `String.prototype` and with
 * native `RegExp`. This class holds both views and the translation between
 * them, decoded once per subject string.
 */
export class Input {
  readonly text: string;
  /** Decoded code points. */
  readonly cps: Int32Array;
  /** `offsets[i]` is the UTF-16 index of code point `i`; length is n + 1. */
  readonly offsets: Int32Array;
  /** UTF-16 index -> code point index, for translating `lastIndex`. */
  private readonly cpIndex: Int32Array;
  /** Number of code points. */
  readonly length: number;

  constructor(text: string) {
    const cps = new Int32Array(text.length);
    const offsets = new Int32Array(text.length + 1);
    const cpIndex = new Int32Array(text.length + 1);
    let n = 0;
    for (let i = 0; i < text.length; ) {
      const cp = text.codePointAt(i)!;
      cps[n] = cp;
      offsets[n] = i;
      const width = cp > 0xffff ? 2 : 1;
      for (let k = 0; k < width; k++) cpIndex[i + k] = n;
      i += width;
      n++;
    }
    offsets[n] = text.length;
    cpIndex[text.length] = n;

    this.text = text;
    this.cps = cps;
    this.offsets = offsets;
    this.cpIndex = cpIndex;
    this.length = n;
  }

  /** Code point index for a UTF-16 offset, clamped into range. */
  toCodePointIndex(utf16Index: number): number {
    if (utf16Index <= 0) return 0;
    if (utf16Index >= this.text.length) return this.length;
    return this.cpIndex[utf16Index];
  }

  /** UTF-16 offset for a code point index. */
  toUtf16Index(cpIndex: number): number {
    return this.offsets[Math.min(Math.max(cpIndex, 0), this.length)];
  }
}
