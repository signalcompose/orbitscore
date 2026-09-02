# Research: エディタホストの選択とアプリサイズ

## 調査日

2026-08-30

## ステータス

調査記録。**「VSCodium をやめて軽い自作環境にできないか」という owner の問いに答えるため**に実施した。

結論は「**自作しない。現行構成のまま、ビルド後処理でサイズを 46% 落とす**」。
サイズ削減は実測で検証済み（下記 §4）。削る拡張の取捨だけが未確定（§6）。

## 発端

owner の問い（原文）:

> ちなみにVSCodiumってアプリとして結構大きいんだけど、この.VSIXの機能拡張をうまく使って、
> もっと軽い環境ってないのかな。

> なるべくテキストエディターの、なんだから、コードベースなんだから、軽い薄い環境にはしたいんだよね。
> 機能拡張を削っても、700メガっていうのはかなり大きいよなという印象ですね。
> …テキストデータを作ること自体は難しくないのか。どうすんのがいいと思う？

調査の途中で owner 自身が要点に到達している:

> テキストエディタを作るだけなら難しくはないんだろうけど、今VSIXの機能拡張に乗ってる機能も
> アプリに全部移植しなきゃいけないっていうことになるんだよね。

> これだったら、VSIXの配布とVSCodeiumを軽くして一緒に配布で、
> VSCodeiumを直接いじるような事態が発生するようならあれだけど。

**本調査はこの見立てを裏づけた。** 以下はその根拠である。

## 関連

- **#656** — OrbitStudio.app の署名・notarization・リリース経路。§5 の再署名要件が直接効く
- **#659** — ローカルリリーススクリプト（`scripts/orbitstudio/make-local-release.sh`）。
  §4 のトリムをこの手順に組み込む
- `scripts/orbitstudio/build_orbitstudio.sh` — アプリのビルド

---

## 1. 「自作エディタ」の実際のコスト

owner の「テキストデータを作ること自体は難しくないのか」は正しい。
**問題はエディタ部分ではなく、その周りだった。**

### 1.1 拡張のうち、持ち出せる部分と書き直す部分

`packages/vscode-extension/src/*.ts` の全ファイルについて `vscode.` の出現数を数えた
（出現 2 箇所以下を「非依存」とした。実際にその 2 箇所はいずれもツール説明文の文字列で、
API 呼び出しではない）。

| 区分 | 行数 | 内容 |
|---|---:|---|
| 拡張 全体 | 9131 | |
| **vscode 非依存** | **4726** | MCP サーバ (1395) / エンジン制御 / カタログ読み取り / 診断 / WAV 解析 / 補完ロジック / playhead。**そのまま持ち出せる** |
| **vscode 依存** | **4405** | **全部書き直し**。うち `extension.ts` が 4115 行 |

`mcp-server.ts` が 1395 行で `vscode.` の実呼び出しゼロ、というのが重要な観察である。
**エンジンを駆動する層はホストに依存していない。** つまり自作したとしても、
そこは移植ではなくコピーで済む。

### 1.2 `extension.ts` が VS Code に頼っているもの

書き直しの中身がエディタでないことは、API の内訳から分かる:

```
 20 vscode.window.showInformationMessage
 20 vscode.commands.registerCommand
 15 vscode.window.showErrorMessage
 14 vscode.workspace.workspaceFolders
 14 vscode.workspace.getConfiguration
 13 vscode.window.showWarningMessage
  9 vscode.window.activeTextEditor
  7 vscode.window.showQuickPick
  7 vscode.DiagnosticSeverity.Warning
  7 vscode.ConfigurationTarget.Global
  6 vscode.ConfigurationTarget.Workspace
  6 vscode.commands.executeCommand
  4 vscode.window.showInputBox
  4 vscode.DiagnosticSeverity.Error
  4 vscode.CompletionItemKind.Method
  3 vscode.window.createTextEditorDecorationType
  3 vscode.languages.registerCompletionItemProvider
  2 vscode.window.registerTreeDataProvider
  2 vscode.window.createStatusBarItem
```

**ダイアログ・コマンドパレット・設定システム・ツリービュー・ステータスバー・診断表示** である。
テキスト編集そのものは 1 つも無い。

自作した場合、これらに加えて **VS Code が無料で提供しているもの** —— 設定 UI、キーバインド、
複数ファイル、検索、undo/redo、git 連携、シンタックスハイライト —— も自前になる。

### 1.3 テキストエディタ部品の実力（CodeMirror 6）

[CodeMirror 6](https://codemirror.net/docs/changelog/) は編集機能を提供する。ただし:

- [`@codemirror/autocomplete`](https://www.npmjs.com/package/@codemirror/autocomplete) は
  **補完の UI は提供するが、候補を出す関数は自分で書く**
- [linting も同様](https://hjr265.me/blog/codemirror-lsp/)で、外部リンタが出した `Diagnostic` を
  `setDiagnostics()` で流し込む設計

つまり §1.1 の「vscode 非依存 4726 行」に含まれる補完・診断ロジックは再利用できるが、
**それを UI に繋ぐ配線（§1.2）は結局書くことになる。**

### 1.4 Tauri のサイズ優位は本物だが、対価が §1.1〜1.3

[Tauri vs Electron の 2026 年時点の比較](https://tech-insider.org/tauri-vs-electron-2026)によれば:

| | Tauri | Electron |
|---|---:|---:|
| バンドル | 3〜10 MB | 120〜200 MB |
| アイドル時メモリ | 42 MB | 168 MB |
| 起動 | 380 ms | 1420 ms |

macOS では OS の WebView (WKWebView) を使うため Chromium を同梱しない、というのが差の理由。
数字としては劇的だが、**支払うのは 4405 行の書き直しと VS Code 由来の全機能**である。

**採らない。**

---

## 2. 現行アプリの内訳（実測）

対象: `orbitstudio-local-builds/20260830-0625-69dc968c-app/OrbitStudio.app`

```
全体                             889 MB
├─ Contents/Frameworks           255 MB   ← Electron 本体。削れない
└─ Contents/Resources/app        617 MB
   ├─ out                        301 MB
   ├─ extensions                 206 MB   （95 個。うち orbitscore 52 MB）
   ├─ node_modules                92 MB
   └─ bin                         19 MB
```

**`out` が拡張より重い。** ここが最初の手がかりだった。

---

## 3. 🔴 発見: 889 MB のうち 334 MB はソースマップ

`out` の中身を分解したところ、**ほぼソースマップだった**。

```
out/ の .map ファイル       29 個 / 251 MB
out/ の .map 以外                    50 MB
アプリ全体の .map                   334 MB
```

上位:

```
87 MB  out/vs/workbench/workbench.desktop.main.js.map
86 MB  out/vs/sessions/sessions.desktop.main.js.map
15 MB  out/vs/workbench/api/node/extensionHostProcess.js.map
14 MB  out/vs/workbench/api/worker/extensionHostWorkerMain.js.map
 8 MB  out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js.map
 8 MB  out/main.js.map
```

ソースマップは**デバッガが minify 前の位置を復元するためだけ**に使われる。
実行時には読まれない。**アプリの 37.6% が、動作に一切関与しないファイルだった。**

なお `.js` 側は minify 済みである（`workbench.desktop.main.js` が存在する）。
つまりビルドターゲットの選択ミスではなく、**minify した上でマップも同梱している**状態。

---

## 4. 実測: 削って動くことを確認した

推論で終わらせず、複製を作って削り、**実際に起動してエンジンを回した**。

### 4.1 手順

```bash
ditto OrbitStudio.app $W/OrbitStudio.app          # 複製
find $W -name "*.map" -delete                      # 段階1
rm -rf $EXT/{mermaid-markdown-features,...}        # 段階2（§6 参照）
codesign --force --deep --sign - $W/OrbitStudio.app # 再署名（§5）
```

### 4.2 サイズ

| 段階 | サイズ | 削減 |
|---|---:|---:|
| 現行 | 889 MB | — |
| 段階1: ソースマップ削除 | **555 MB** | −334 MB |
| 段階2: 不要拡張も削除 | **481 MB** | −408 MB（**46%**） |

拡張数 95 → 74。

### 4.3 動作確認（実出力）

```
MCP 応答                 6 秒
start_engine             {"text":"engine starting"}
evaluate_orbitscore      {"text":"ok"}          ← これ単体は根拠にならない
get_log (400行)          ERROR 行: 0
get_engine_state         {"running":true,"liveCoding":true}
stop_engine              {"text":"engine stopping"}
```

評価対象は `Soundcinema_Düsseldorf_2026/840/840.orbs`（7 レイヤー）。
`--extensions-dir` を空ディレクトリにして起動しており、**同梱拡張だけで動いている**ことを
確認している。

### 4.4 🔴 この検証の限界（正直な但し書き）

- **`[STEP]` マーカーは 0 件だった。** これは playhead が壊れているのではなく、
  `start_engine` を `debug: true` なしで呼んだため `[STEP]` が `get_log` に届かないから。
  **今回の検証では playhead を確認していない**
- **スピーカーで音を聴いていない。** ログ上 ERROR 0 かつ transport running までの確認である
- 上記 2 点は、トリムを `make-local-release.sh` に組み込む際に
  既存の gated E2E (`ORBIT_GATED_ORBITSTUDIO=1`) を通すことで埋める

---

## 5. 🔴 削ると署名が壊れる（リリース手順に効く）

トリム直後の検証:

```
$ codesign -v OrbitStudio.app
OrbitStudio.app: code has no resources but signature indicates they must be present
```

**署名済みバンドルからファイルを削除すると署名が無効になる。**
これは自明に見えるが、手順の順序を決める:

```
ビルド → トリム → 署名 → notarize → staple
```

トリムを署名の**後**に置くと notarization が通らない。`#656`（署名・notarization）と
`#659`（ローカルリリーススクリプト）の両方に効く制約である。

---

## 6. 未確定: どの拡張を削るか

§4 で削った一覧は**調査者（main）の判断**であり、owner 確認を経ていない。

削除した 21 個:
```
mermaid-markdown-features (56MB)  microsoft-authentication (8MB)
github-authentication (3MB)       github (3MB)
ms-vscode.js-debug (3MB)          ms-vscode.js-debug-companion
ms-vscode.vscode-js-profile-table (3MB)
css-language-features (8MB)       html-language-features (12MB)
json-language-features (7MB)      typescript-language-features (4MB)
php-language-features             grunt  gulp  jake  npm
emmet  merge-conflict  terminal-suggest
debug-auto-launch  debug-server-ready
```

**要検討の 2 件:**

- `typescript-language-features` — `840/perform/cue.ts` を OrbitStudio 上で編集するなら残すべき。
  演奏用スクリプトは TypeScript である
- `mermaid-markdown-features` (56MB) — docs の Markdown プレビューで mermaid 図を見るかどうか

**判断の余地が無いのはソースマップ削除（334 MB）だけ**なので、そこだけ先に手順へ入れ、
拡張の取捨は一覧を出して別途決めるのが安全である。

---

## 7. 結論と、名前についての所見

### 7.1 結論

**自作しない。VSIX 配布 + 軽量化した VSCodium を同梱で配布する（owner の判断どおり）。**

サイズは 889 → 481 MB（46% 減）。設計変更ゼロ、ビルド後処理のみ。

### 7.2 「OrbitStudio という名前が大げさ」について

owner の所感:

> なんかでもOrbitStudioって名前を付けてるけど、大げさな感じがすごいするなっていうのは、
> でもインストールが楽っていうのは、初めから入ってれば楽なのは間違いがないんだよな。

本調査で確定した事実として、**`.vsix` が機能の 100% を持っており、アプリ側に固有の実装が
1 行も無い**（コマンド・ビューコンテナ・メニュー・キーバインド・文法はすべて拡張由来。
proposed API 不使用、アプリ名による分岐なし）。

したがって**アプリは製品ではなく配布形式**である。この位置づけを保つ限り:

- VSCodium 上流への追従が rebase 一発で済む
- バージョンは自動的に揃う（アプリの中身の差分が拡張しか無いため、
  アプリ版 = 拡張版 が定義として成立する）

**逆に、workbench を直接いじりたくなった時が名前を考え直す時**である。
その時点でアプリは配布形式ではなく製品になり、上流追従コストとバージョン体系の
両方が変わる。

---

## 8. 次のアクション

1. `make-local-release.sh` に **ソースマップ削除**を無条件で組み込む（−334 MB・判断の余地なし）
2. 順序を「ビルド → トリム → 署名 → notarize」に固定する（§5）
3. 拡張の取捨は一覧を owner に提示してから決める（§6）
4. トリム後のアプリで gated E2E を通し、§4.4 の限界（playhead・実音）を埋める
