<div id="title-block-header" class="header">

<div class="docmeta">

{"type":"meta","doc":"SESSION_LOG_SPEC","version":"1","status":"draft-for-implementation","date":"2026-06-12","theme":"causal-record"}

</div>

</div>

# OrbitScore Session Log Specification — v1 “Causal Record”

**Status**: Draft for implementation **Date**: 2026-06-12 **Authors**: Hiroshi Yamato (design decisions) / Claude (drafting) **Relation**: PITCH_DSL_SPEC_v1.1.md と対をなす。実装は v1.1 Phase 1(評価経路)に同乗する(IMPLEMENTATION_INSTRUCTIONS.md 参照)。

------------------------------------------------------------------------

## 0. Design Principles (normative)

1.  **記録 = 因果、録音 = 現象**: 本仕様が記録するのは**原因**(評価されたコードとその音楽的時刻)であって**結果**(出力音、画面、キーストローク)ではない。スクリーンキャプチャ・キーストローク捕捉は「録音」に分類し、本仕様のスコープ外とする。
2.  **再現性 = 因果的同一性**: リプレイが保証するのは因果連鎖の同一性であり、音響的同一性ではない。ランダム要素(`r` 等)は**原因(コード)として記録し、リプレイ時に再度引く**。「毎回違ってよい」という演奏者の意図ごと再現するのが因果の記録である。
3.  **ログが真実の源泉**(イベントソーシング): 任意時点のエンジン状態はログの畳み込みとして一意に定まる。状態のスナップショットは保存しない(プリアンブルとメタを除く)。
4.  **分岐の出発点 = エンジン状態**: ログを時刻 t まで畳み込んだエンジン状態から音は続行する。エディタ状態は復元しない(必要なら演奏者が画面に再構築する)。
5.  **人間と LLM で形式を分けない**: 同一の `.orbslog` が、人間のリプレイ・検証・譜面抽出と、LLM エージェントの few-shot 学習素材を兼ねる。

------------------------------------------------------------------------

## 1. Recording Lifecycle (フライトレコーダー方式)

![](data:image/svg+xml;base64,PHN2ZyB2aWV3Ym94PSIwIDAgODgwIDIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiByb2xlPSJpbWciIGFyaWEtbGFiZWw9IuOCu+ODg+OCt+ODp+ODs+ODreOCsOOBruODqeOCpOODleOCteOCpOOCr+ODqyIgc3R5bGU9Im1heC13aWR0aDoxMDAlO2hlaWdodDphdXRvO2ZvbnQtZmFtaWx5OiYjMzk7SGlyYWdpbm8gU2FucyYjMzk7LCYjMzk7WXUgR290aGljJiMzOTssc2Fucy1zZXJpZjsiPgogIDxzdHlsZT4KICAgIC5ie2ZpbGw6I0ZGRkZGRjtzdHJva2U6IzE2MTgxRDtzdHJva2Utd2lkdGg6MS4zO30KICAgIC5iZ3tmaWxsOiNGMkYyRUY7c3Ryb2tlOiM5QTlBQTA7c3Ryb2tlLXdpZHRoOjEuMjtzdHJva2UtZGFzaGFycmF5OjQgMzt9CiAgICAuYnJ7ZmlsbDojRkZGM0YyO3N0cm9rZTojQjQyMzFGO3N0cm9rZS13aWR0aDoxLjM7fQogICAgLnR7Zm9udC1zaXplOjEyLjVweDtmaWxsOiMxNjE4MUQ7Zm9udC13ZWlnaHQ6NjAwO30KICAgIC5ze2ZvbnQtc2l6ZToxMC41cHg7ZmlsbDojNUE1QTYwO30KICAgIC5le3N0cm9rZTojMTYxODFEO3N0cm9rZS13aWR0aDoxLjI7ZmlsbDpub25lO30KICAgIC50bHtzdHJva2U6IzE2MTgxRDtzdHJva2Utd2lkdGg6MS40O30KICA8L3N0eWxlPgogIDxkZWZzPjxtYXJrZXIgaWQ9ImxhIiB2aWV3Ym94PSIwIDAgMTAgMTAiIHJlZng9IjkiIHJlZnk9IjUiIG1hcmtlcndpZHRoPSI2LjUiIG1hcmtlcmhlaWdodD0iNi41IiBvcmllbnQ9ImF1dG8tc3RhcnQtcmV2ZXJzZSI+PHBhdGggZD0iTTAsMCBMMTAsNSBMMCwxMCB6IiBmaWxsPSIjMTYxODFEIiAvPjwvbWFya2VyPjwvZGVmcz4KICA8bGluZSB4MT0iMzAiIHkxPSIxMjAiIHgyPSI4NTAiIHkyPSIxMjAiIGNsYXNzPSJ0bCIgbWFya2VyLWVuZD0idXJsKCNsYSkiPjwvbGluZT4KICA8cmVjdCB4PSI0MCIgeT0iNDAiIHdpZHRoPSIyMDAiIGhlaWdodD0iNTYiIGNsYXNzPSJiZyIgLz4KICA8dGV4dCB4PSI1MiIgeT0iNjIiIGNsYXNzPSJ0Ij7oqZXkvqHjg63jg7zjg6rjg7PjgrDjg5Djg4Pjg5XjgqE8L3RleHQ+CiAgPHRleHQgeD0iNTIiIHk9IjgwIiBjbGFzcz0icyI+aW5pdCAvIHRlbXBvIC8gc2Vx5a6a576pIC8gbWlkaSgp4oCmPC90ZXh0PgogIDxjaXJjbGUgY3g9IjI4MCIgY3k9IjEyMCIgcj0iNyIgZmlsbD0iI0I0MjMxRiI+PC9jaXJjbGU+CiAgPHRleHQgeD0iMjUyIiB5PSIxNDYiIGNsYXNzPSJ0Ij5nbG9iYWwuc3RhcnQoKTwvdGV4dD4KICA8dGV4dCB4PSIyNDAiIHk9IjE2MiIgY2xhc3M9InMiPuODleOCoeOCpOODq+eUn+aIkDogbmFtZS4yMDI2MDYxMi0yMTMwLm9yYnNsb2c8L3RleHQ+CiAgPHJlY3QgeD0iMzAwIiB5PSI0MCIgd2lkdGg9IjEzMCIgaGVpZ2h0PSI1NiIgY2xhc3M9ImJyIiAvPgogIDx0ZXh0IHg9IjMxMiIgeT0iNjIiIGNsYXNzPSJ0Ij5tZXRhICsgcHJlYW1ibGU8L3RleHQ+CiAgPHRleHQgeD0iMzEyIiB5PSI4MCIgY2xhc3M9InMiPnRyYW5zcG9ydDogbnVsbDwvdGV4dD4KICA8cmVjdCB4PSI0NTAiIHk9IjQwIiB3aWR0aD0iMjQwIiBoZWlnaHQ9IjU2IiBjbGFzcz0iYiIgLz4KICA8dGV4dCB4PSI0NjIiIHk9IjYyIiBjbGFzcz0idCI+ZXZhbCAvIHRyYW5zcG9ydCDjgqTjg5njg7Pjg4jov73oqJg8L3RleHQ+CiAgPHRleHQgeD0iNDYyIiB5PSI4MCIgY2xhc3M9InMiPndhbGwgKyBiYXI6YmVhdCArIGVmZmVjdCAvIOihjOWNmOS9jeODleODqeODg+OCt+ODpTwvdGV4dD4KICA8Y2lyY2xlIGN4PSI3MzAiIGN5PSIxMjAiIHI9IjciIGZpbGw9IiMxNjE4MUQiPjwvY2lyY2xlPgogIDx0ZXh0IHg9IjcwNiIgeT0iMTQ2IiBjbGFzcz0idCI+c3RvcCAvIOeVsOW4uOe1guS6hjwvdGV4dD4KICA8dGV4dCB4PSI2NjAiIHk9IjE2MiIgY2xhc3M9InMiPnN0b3Djg6zjgrPjg7zjg4kgb3Ig5Y2Y44Gr6YCU57W2KOOBqeOBoeOCieOCguacieWKueOBquiomOmMsik8L3RleHQ+CiAgPHBhdGggY2xhc3M9ImUiIGQ9Ik0yNDAsNjggTDI5NCw2OCIgbWFya2VyLWVuZD0idXJsKCNsYSkiIC8+CiAgPHBhdGggY2xhc3M9ImUiIGQ9Ik00MzAsNjggTDQ0NCw2OCIgbWFya2VyLWVuZD0idXJsKCNsYSkiIC8+CiAgPHBhdGggY2xhc3M9ImUiIGQ9Ik03NzAsMTEwIEw4MDAsODAgTDgzMCw4MCIgc3Ryb2tlLWRhc2hhcnJheT0iMyAzIiAvPgogIDx0ZXh0IHg9Ijc2MCIgeT0iNjgiIGNsYXNzPSJzIj7lho1zdGFydCA9IOaWsOODleOCoeOCpOODqzwvdGV4dD4KPC9zdmc+)

- **常時バッファ**: エンジン起動後、すべての評価をローリングバッファに保持する(明示的な録音開始操作は存在しない)。
- **セッション開始 = `global.start()`**: この時点でログファイルを生成し、(1) メタヘッダ、(2) バッファ内容を**プリアンブル**として書き出し、(3) 以降の評価を時刻付きで追記する。
- **プリアンブル**: start 以前の評価列(`init GLOBAL`, `tempo`, `beat`, `audioPath`, seq 定義, `seq.midi()` 等)。壁時計時刻あり、トランスポート時刻は `null`(トランスポート未走行のため)。因果連鎖の完全性のために必須。
- **セッション終了 = `global.stop()` またはエンジン終了**: stop イベント自体を最終レコードとして記録しファイルを閉じる。再度の `global.start()` は**新しいセッションファイル**を開始する(直前 stop までの評価は新バッファとして次のプリアンブルに入る)。
- **異常終了**: 追記専用 + 行単位フラッシュのため、プロセスが落ちても失われるのは最大で書きかけの1行。stop レコードを持たないログは「終了イベントなしに終わったセッション」としてそのまま有効(LOOP 中の強制終了等も因果の記録として読める)。リカバリ処理は不要。
- 保存は自動。命名・選別(価値あるセッションへの命名)は事後の操作とする。

## 2. File Naming and Location

- **配置**: `global.start()` を評価した `.orbs` ファイルと**同一ディレクトリ**。
- **命名**: `<basename>.<YYYYMMDD-HHMMSS>.orbslog`(例: `mypiece.20260612-2130.orbslog`)。basename は `.orbs` から継承、タイムスタンプはセッション開始時刻。同一 `.orbs` からの複数セッションはタイムスタンプで弁別される。
- **複数ファイルセッション**: セッションはファイルではなく**エンジンに束縛**される。複数の `.orbs` から評価が行われてもログは一本で、各評価レコードが `sourceFile` を持つ(§3)。命名は start を評価したファイルに従う。
- **未保存バッファ**: `untitled.<timestamp>.orbslog` フォールバック(エンジンの作業ディレクトリに置く)。
- git 管理を想定したテキスト形式(JSONL)。

## 3. Log Format (JSONL)

1行目: メタヘッダ。以降: 1行 = 1イベント。

``` jsonl
{"type":"meta","logVersion":1,"engineVersion":"1.1.0","dslVersion":"1.1","startedAt":"2026-06-12T21:30:05+09:00","sourceFile":"mypiece.orbs","assets":[{"path":"~/Clean-Samples/bd/BD0000.wav","sha256":"..."}]}
{"type":"eval","wall":0,"transport":null,"sourceFile":"mypiece.orbs","code":"var global = init GLOBAL\nglobal.tempo(120)\nglobal.beat(4 by 4)"}
{"type":"eval","wall":1204,"transport":null,"sourceFile":"mypiece.orbs","code":"var kick = init global.seq\nkick.midi(\"IAC Driver Bus 1\", 1)"}
{"type":"transport","wall":3500,"event":"start"}
{"type":"eval","wall":12040,"transport":"2:3.482","effect":"3:1.0","code":"kick.play(1, 0, (3, 5), 7).root(2)","sourceFile":"mypiece.orbs"}
{"type":"eval","wall":15800,"transport":"3:2.911","effect":null,"code":"global._tempo(132)","sourceFile":"mypiece.orbs"}
{"type":"transport","wall":98000,"transport":"24:4.0","event":"stop"}
```

フィールド定義:

| field | 内容 |
|----|----|
| `wall` | エンジン/ローリングバッファ起動からの壁時計ミリ秒。各レコードは**発生時刻でスタンプ**する(プリアンブルを flush 時に再スタンプしない)。よってプリアンブルの `wall` は start レコードより小さい(例: preamble `wall:0` \< start `wall:3500`)。メタヘッダの `startedAt` は `global.start()` 時刻の ISO |
| `transport` | 音楽時間 `bar:beat`(beat は小数)。プリアンブルでは `null` |
| `effect` | quantize を通る操作の**解決済み効果時刻**(実際に反映された境界)。即時系(`_` 接頭辞、gain 等)では `null` |
| `code` | 評価されたテキストそのまま(選択範囲の生文字列) |
| `sourceFile` | 評価元ファイル(相対パス) |
| `evalSource` | 評価の主体: `"human"` / `"agent"` / `"replay"`。人間オペレーターと LLM エージェントが同一の評価経路を共有する構成(コンサートシステム等)で、介助と自律を評価単位で識別可能にする |
| `type` | `meta` / `eval` / `transport`(start/stop/tempo はエンジン確定値として二重記録) |

**三重スタンプの理由**: リプレイの駆動は音楽時間(`transport`)で行う。壁時計駆動では quantize 境界の前後 10ms の差が反映小節を丸ごとずらし、再現が壊れる。`effect` は検証とログの可読性(「この差し替えは何小節目から効いたか」)のため。テンポ変更自体がログイベントなので、音楽時間の参照系はログ内で自己完結する。

### 3.1 v1 (L1 \#229) 実装スコープと既知の割り切り

L1 writer の初版(#229)は以下を確定スコープとする。いずれも因果記録としての正しさは保つ(より細粒度・CLI 完全)が、editor 経路の一部は follow-up に送る。

- **writer は opt-in(既定 inert)**: 実エントリ(CLI play / REPL / 拡張)でのみ writer を装着する。ユニットテストが叩く `Global`/`Sequence` 構築経路では writer は不在で、`global.start()` は**ファイルを生成しない**(既存テスト群の汚染防止)。
- **`code` 粒度 = `execute()` 単位**: REPL/editor 経路はパース成立した単位(独立にパース可能なら文ごと)、CLI play はファイル全体が 1 レコード。1 選択 = 1 レコードにする selection-atomic framing は protocol 追加が要るため follow-up(細粒度でも因果記録としては有効)。
- **命名/`sourceFile`**: CLI 経路は `.orbs` パスを持つので basename 命名・`sourceFile` が完全に機能する。editor 経路は現状エンジンへファイル名を渡さない(`setDocumentDirectory` はディレクトリのみ)ため v1 は `untitled.<timestamp>.orbslog` フォールバック。editor からのファイル名伝達(ログに混じらない制御チャネル)は follow-up。
- **`effect` 範囲**: v1 は **LOOP 起動**の解決済み境界のみ `nextQuantizedTime` で算出。走行中ループへの `play()` 差し替え・`tempo/beat/length` の次サイクル遅延は `effect:null`(follow-up)。replay は `transport` 駆動で再 quantize するため再現性に影響せず、`effect` は可読性/検証の補助に留まる。
- **tempo の二重記録**: v1 は `start`/`stop` のみ `transport` レコード化。`tempo` 変更は `eval` レコードとして残す(上の例に一致)。`tempo` の `transport` 二重記録は follow-up。
- **単一 GLOBAL 前提**: transport フックは最初の `GLOBAL` に一度だけ装着する。同一セッションで2つ目の `init GLOBAL` を定義・使用した場合、その global の `start()/stop()` はログに記録されない。通常 1 セッション = 1 GLOBAL のため v1 ではスコープ外(follow-up)。

## 4. Replay

    orbitscore replay mypiece.20260612-2130.orbslog              # 忠実リプレイ(実時間)
    orbitscore replay <log> --until 57:1                          # 分岐リプレイ: bar 57 頭まで畳み込み、ライブに引き継ぐ
    orbitscore replay <log> --render out.wav                      # オフラインレンダー(faster-than-realtime)
    orbitscore replay <log> --verify                              # 検証モード(§5)

- リプレイヤーはエンジンから見て**もう一人の評価送信者**(VS Code 拡張と同じ口)。エンジン側に専用経路を作らない。
- 駆動は `transport` 時刻。プリアンブルは start 前に順次投入。
- **アセット検証**: メタヘッダのハッシュと現環境を照合し、不一致は**警告して続行**。
- `--until` 後はエンジン状態のみ引き継ぐ(原則 4)。エディタには何も書き込まない。

## 5. Verification (検証層)

リプレイが元と同一のイベント列を生んだかを、エンジンイベント(スケジュール済み TimedEvent)の比較で確認する。

- ランダム由来のイベントは**構造のみ比較**(発音の事実とタイミングは一致を要求、値は不問)または除外。因果的同一性(原則 2)の検証であって音響的同一性の検証ではない。
- 完全一致検証が必要になった場合のための `randseed` 記録はランダム機能再導入時の課題(現行 v3.0 にランダム機能は存在しない)。

## 6. Out of Scope

- キーストローク・画面・エディタ状態の記録/復元(「録音」であり本仕様の対象外。原則 1, 4)
- Ableton 側の状態(エフェクト、録音)。分業: **Ableton は音響結果を、OrbitScore は因果過程を記録する**。両者を合わせたものが演奏の完全なドキュメンテーション
- 協調(複数人)セッションのマージ
- ログの暗号化・改竄検知

## 7. Future Directions (本仕様の外、Issue 候補)

1.  **譜面抽出**: ログ畳み込み + PITCH_DSL_SPEC §7-0(シンボリック保持)により、演奏終了後にその演奏の総譜を生成できる。譜面エピックと合流。
2.  **LLM few-shot 素材**: `.orbslog` をそのまま LLM バンドメンバー(ライブコーディングする LLM)の学習素材とする。形式を分けない(原則 5)ため追加コストなし。別途議論予定。
3.  **セッション間 diff**: 同一曲の複数セッションの構造比較(リハーサル分析)。
4.  **preamble バッファの上限**(#276 deferred): `start()` を呼ばず eval を延々続けると preamble が無制限に成長する。ただし「oldest を捨てる」は `init GLOBAL` 等の因果の根を失うため不可。早期 flush 等の正しい上限設計は v2。通常用途では `start()` を早期に呼ぶため実害なし。
5.  **version の自動同期**(#276 deferred): meta ヘッダの `engineVersion` は現状 `version.ts` にハードコード。monorepo(engine パッケージ版 ≠ 製品版)+ dist layout のため動的読みは脆く、ビルド時注入/リリーススクリプトで解くべき v2 事項。

## 8. Open Questions

1.  ライブセット内で `stop()`/`start()` を挟む演出(メドレー等)のセッション分割が演奏記録として適切か。1公演=1ログのグルーピング機構(ディレクトリなりマニフェストなり)が要るかは運用後に判断。
2.  プリアンブルのローリングバッファ保持期間(エンジン起動からの全評価か、直近 N 件か)。推奨: 直前の stop 以降の全評価(セッション間で自然にリセット)。
3.  `--until` の停止位置と quantize の相互作用(境界ちょうどで止めた場合、待機中の差し替えを適用してから引き継ぐか)。実装時に確定。
