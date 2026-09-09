# resafe

**ReDoS を構造的に不可能にする正規表現エンジン。** TypeScript 製・依存ゼロ・ビルド不要。

バックトラックを一切使わず、Thompson NFA を Pike VM でシミュレートします。マッチ計算量は
入力長 × パターン長に対して線形で、パターンがどれだけ曖昧でも指数爆発しません。

```
/(a+)+$/ に "a".repeat(n) + "!" を与えたとき

         n   native RegExp        resafe
        20         16.0 ms        143 us
        25        460.0 ms        145 us
        28          3.52 s        181 us
    100000       (測定不能)       21.0 ms
```

`n = 28` で組み込み `RegExp` は 3.5 秒かかり、以降は指数的に伸びて実質停止します。resafe は
同じパターンで 10 万文字を 21 ミリ秒で処理します。**同じアルゴリズムを速くしたのではなく、
バックトラックという探索そのものを持っていない**のが理由です。

## 使う

Node.js 22.6 以降。型は実行時にストリップされるのでビルド手順はありません。

```ts
import { SafeRegExp } from "resafe";

const re = new SafeRegExp("(?<year>\\d{4})-(?<month>\\d{2})", "g");

re.test("2026-09");                       // true
[...re.matchAll("2026-09 / 1999-12")];    // 2 件
"2026-09-09".replace(new SafeRegExp("(\\d+)-(\\d+)-(\\d+)"), "$3/$2/$1");
                                          // "09/09/2026"
```

`Symbol.match` / `matchAll` / `search` / `split` / `replace` を実装しているので、
`String.prototype` のメソッドにそのまま渡せます。`lastIndex`、`g` / `y` の挙動、
`exec` の戻り値の形（`index` / `input` / `groups` / `d` フラグの `indices`）は
組み込み `RegExp` と同じです。

### CLI

```console
$ resafe -n '(\d{4})-(\d\d)-(\d\d)' access.log
$ resafe --explain 'a+b'
000  save   0
001  char   [a]
002  split  1, 3
003  char   [b]
004  save   1
005  match
```

終了ステータスは grep 互換（0 = マッチあり / 1 = なし / 2 = エラー）です。

## なにを捨てたか

**後方参照 (`\1`) と先読み・後読み (`(?=)` `(?!)` `(?<=)` `(?<!)`) は実装しません。**
できないのではなく、入れると線形時間の保証が壊れるからです。後方参照つきのマッチングは
NP 完全であることが知られており、先読みも正規言語の演算ではありません。この 2 つを外すことが
そのまま「最悪計算量が存在する」という保証になります。

これらはパース時に専用の例外で、理由つきで弾かれます。

```console
$ resafe 'ab(?=c)' file.txt
resafe: UnsupportedPatternError: lookahead '(?=' is not supported: it is not a
regular operation, and dropping it is what buys the linear-time guarantee
  /ab(?=c)/
    ^
```

`\p{...}`（Unicode プロパティ escape）は現状 未実装です。それ以外の JavaScript の正規表現構文
—— 文字クラス、`.`、量指定子（`* + ? {n,m}` と `?` つきの遅延版）、選択、キャプチャ／名前付き
キャプチャ、`^ $ \b \B`、フラグ `d g i m s y` —— はサポートします。パターンは常に Unicode
モード（`u` 相当）で解釈され、`.` はサロゲートペアを 1 文字として扱います。

## しくみ

```
パターン文字列
   ↓  parser.ts     再帰下降パーサ → AST
   ↓  compiler.ts   Thompson 構成 → フラットな命令列
   ↓  pike.ts       Pike VM で NFA を並列シミュレート
マッチ結果
```

命令は 7 つだけです。`char`（1 コードポイント消費）、`split`（優先度つき分岐）、`jmp`、
`save`（キャプチャ位置の記録）、`clear`（キャプチャのリセット）、`assert`（`^ $ \b \B`）、
`match`。

Pike VM は「バックトラックしない」代わりに、**入力位置ごとにスレッド集合を持ち、
プログラムカウンタで重複除去しながら一斉に 1 文字進めます**。プログラム長を m、入力長を n と
すると、各位置で生きられるスレッドは高々 m 本なので、全体の仕事量は O(n·m) で頭打ちになります。
`(a+)+$` に指数的な探索経路が「ある」のではなく、この構造では**探索するものが存在しない**のです。

スレッドは優先度順に保持され、`match` に到達したスレッドはそれより低優先度のスレッドを
その場で打ち切ります。これで、バックトラック実装と同じ leftmost-first（最左最優先）の
貪欲／遅延セマンティクスが、バックトラックなしで再現されます。

### ECMAScript のセマンティクスに寄せた点

NFA 系エンジン（RE2, Go, Rust）とは違い、JavaScript 固有の 2 つの規則を実装しています。

- **反復ごとのキャプチャリセット。** `/(?:(a)|b){2}/.exec("ab")` はグループ 1 が `undefined`
  になります。仕様の `RepeatMatcher` が反復の先頭で内部グループをクリアするためです。これは
  `clear` 命令 1 個で表現でき、線形時間の保証を壊しません。
- **`i` フラグは「畳み込んでから否定」。** `/[^a]/i` は `A` にマッチしてはいけません。先に否定
  してから case folding すると `A` の折り返しで `a` が集合に入り込み、誤マッチします。
  文字集合は否定より前に必ず畳み込みます。`\w` が `i` つきで `ſ`（U+017F）にマッチし、
  `\b` の語境界判定もそれに追随する点まで仕様どおりです。

case folding のテーブルは実行環境の `toLowerCase` / `toUpperCase` から導出しており（cased な
コードポイントは全部で 32 レンジ・約 3300 個）、テストが実行時に全コードポイントを走査して
テーブルの欠落を検出します。Node のバージョンが上がって Unicode データが変わっても、
`i` マッチが黙って劣化しません。

## 正しさをどう確かめているか

**差分ファズテスト。** 決定的な PRNG でパターンと入力を生成し、`u` フラグつきのネイティブ
`RegExp` と、マッチの有無・開始位置・全キャプチャを突き合わせます。入力にはアストラル文字、
`ſ` / `K`（ケルビン記号）/ `ß` / `İ` / `ı` といった case folding の境界事例を混ぜています。
40 シード × 約 35 万件の比較で不一致ゼロ。開発中に実際、`[^ab]` の folding 順序バグと
`\b` の語集合バグをこれが検出しました。

**計算量そのものの検証。** VM は命令実行回数を数えており、`(a+)+$` `(a*)*b` `(x+x+)+y` などの
古典的な破滅パターンに対して `3 × (n+1) × プログラム長` という上界を **時間ではなく回数で**
アサートします。負荷のかかった CI でも flaky にならず、主張していることそのものを検証できます。

意図的に比較対象から外している既知の差異は 2 つだけで、どちらもテスト内に理由を書いています。

1. **空反復。** `(?:x{0,2}?)?` のように「空にマッチしうる本体を持つ省略可能な反復」では、
   ECMAScript は空の反復を失敗させて本体へバックトラックします。NFA シミュレーションには
   対応する規則がありません。受理する言語は同じで、同じ開始位置での選ばれ方だけが変わるため、
   マッチの有無は常に比較しています。
2. **サロゲートペア内部の `\b` / `\B`。** V8 は `u` フラグつきでもサロゲートペアの内側の位置で
   `\B` をマッチさせます（`/\B/gu` が `"x😀😀ab"` で index 2 を返す）。仕様の
   `RegExpBuiltinExec` はその位置をマッチャに渡し得ない（`AdvanceStringIndex` がペアを
   またぐ）ため、resafe は仕様どおりの挙動を選んでいます。

```console
$ npm test        # 46 tests
$ npm run typecheck
$ npm run bench
```

## 速度について（正直な話）

破滅パターン以外では、V8 の組み込みエンジンのほうが速いです。

```
    pattern               native      resafe    ratio
    date + email          405 us     23.4 ms      58x
    word scan             861 us     26.0 ms      30x
    literal-ish           224 us      3.9 ms      17x
```

（共有マシンでの 1 回分の実測値です。同じ環境でも実行ごとに 20〜60 倍の範囲でぶれます。
`npm run bench` で手元の数字が取れます。）

JIT コンパイルされたバックトラッカ（Irregexp）と、JavaScript で書かれた NFA シミュレータの
差なので、これは想定どおりです。実装済みの最適化は、パターンの先頭文字集合による開始位置の
スキップ、`test()` でのキャプチャ追跡の省略（割り当てゼロ）、コードポイント列の一度きりの
デコードなど。プロファイル上は VM のループ本体が支配的で、遅い箇所が一点あるわけではありません。

さらに詰めるなら、RE2 が採る二段構え（まずキャプチャなしで終端を求め、その後キャプチャ用に
再実行する）や lazy DFA の導入が次の一手ですが、現状は入れていません。

**使いどころ**は「パターンや入力が信頼できない場所」です。ユーザーが正規表現を入力できる
検索機能、外部から来る文字列に対するバリデーション、ログ解析。そこでは 30 倍の定数倍より、
最悪計算量が存在することのほうが価値があります。

## API

| | |
|---|---|
| `new SafeRegExp(source, flags?, options?)` | フラグは `d g i m s u y`（`u` は常時有効なので無視） |
| `.test(s)` / `.exec(s)` / `.matchAll(s)` | `RegExp` と同じ形の結果 |
| `.lastIndex` | `g` / `y` で使用 |
| `.compiled` | コンパイル済みプログラム（`disassemble()` に渡せる） |
| `.stepCount` | 直前のマッチでの命令実行回数 |
| `SafeRegExp.escape(text)` | リテラルをパターンに埋め込めるようにエスケープ |
| `compile(source, options)` / `parse(source)` | 下位レイヤ |
| `RegexSyntaxError` / `UnsupportedPatternError` / `RegexCompileError` | `.index` と `.format()` を持つ |

`{n,m}` の展開はプログラム長 200,000 命令で打ち切られ、`RegexCompileError` になります
（`options.maxProgramSize` で変更可）。パターン自体をメモリ枯渇の手段にさせないためです。

## 参考

- Russ Cox, *Regular Expression Matching Can Be Simple And Fast* (2007)
- Russ Cox, *Regular Expression Matching: the Virtual Machine Approach* (2009)
- ECMA-262, 22.2 RegExp (Regular Expression) Objects

## ライセンス

MIT
