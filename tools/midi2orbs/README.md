# MIDI → OrbitScore transcriber

Standard MIDI File を OrbitScore DSL (`.orbs`) へ機械的に変換する小さなユーティリティ。
Phase R/Phase 4（`*n`・`[ ]`・`_` タイ・声部タイ・度数+`^`レンジ）を**実在の
パブリックドメイン曲**で実機検証するために書いた。生成した `.orbs` は
`tools/midi-monitor`（`midi-run` + ブラウザモニター）で鳴らして確認する。

> 出自: 2026-06-14 の Phase R/4 実装後の検証セッション。「合成テストではなく実曲で
> エンジン経路を確かめる」ために作成。CI 用ではない（人間/リハ用の検証ハーネス）。

## スクリプト

| ファイル | 役割 |
|---|---|
| `smf.js` | 最小の SMF パーサ（note-on/off を絶対 tick で抽出）。デバッグ表示用にも単体実行可 |
| `midi2orbs.js` | **声部モード**: 各 MIDI チャンネル＝1声部を**単音シーケンス**へ。度数+`^`レンジ、保持は `_` タイ。対位法/旋律+伴奏（例: ラヴェル パヴァーヌ）向き |
| `midi2orbs-chordal.js` | **和音モード**: 各拍の同時発音を縦に集めて `[ ]` スタックへ。保持声部を検出して `_n` 声部タイに。ホモフォニー（例: バッハ コラール）向き |

## 使い方

```bash
# 和音モード（コラール等）: 環境変数で調・小節数・テンポ・トランスポートを指定
OUT=out.orbs KEY=D TONIC_PC=2 BARS=8 TEMPO=60 TRANSPORT=LOOP \
  node tools/midi2orbs/midi2orbs-chordal.js input.mid
# 声部モード（パヴァーヌ等）
OUT=out.orbs TEMPO=60 TRANSPORT=LOOP node tools/midi2orbs/midi2orbs.js input.mid
# 生成後: tools/midi-monitor をブラウザで開き、 npm run midi-run -- out.orbs
```

`TONIC_PC` は主音のピッチクラス（C=0, D=2, …）。`KEY` は `global.key()` 用の文字列。
ピッチ→度数+alteration+`^range` の写像は調に対して機械的で、**出力 MIDI を元 MIDI と
照合して一致を確認済み**（捏造ではない）。

## デモ（`tools/midi-monitor/`）

| ファイル | 曲 | 著作権 | 主眼 |
|---|---|---|---|
| `pavane.orbs` | Ravel «亡き王女のためのパヴァーヌ» 冒頭8小節（3声） | PD (1899) | 複数シーケンス＝対位法、度数+`^` |
| `chorale.orbs` | Bach コラール «O Haupt voll Blut und Wunden» 8小節 | PD | `[ ]` 和音 + `_n` 声部タイ（保持声部） |
| `phase-r4-tour.orbs` | Phase R/4 機能ツアー（自作） | 原作 | `*n`/パターン変数/`_`/`{ }`/`.hold()` |

> 著作権のある MIDI 本体はコミットしない。デモはすべて PD 曲の写経 or 自作。

## このセッションで分かったこと（DSL フィードバック）

- **度数モデルとオクターブ越え**: 実曲の旋律/バスは主音オクターブをまたぐため、生成 DSL は
  `^` レンジ指定だらけになる（度数 10/12 が受理外なことも相まって）。絶対オクターブ記法 or
  非 sticky モードを将来検討する材料。
- **多声の2手段**: ホモフォニー（和音が同リズム）→ `[ ]`、対位法（声部ごと別リズム）→ 複数
  シーケンス。transcriber もこの2モードに分かれる。
- **タイ と ツリー音価の相補性**: 「和音まるごとの保持」はツリー分割でも書けるが、各要素は
  再打鍵。**1声部だけ保持して他声部は動く（サスペンション）は `_n` 声部タイでしか書けない**。

## 制約

env 変数インターフェースは粗く、量子化はグリッド固定（声部モード=8分、和音モード=4分）。
任意の MIDI を綺麗に変換する汎用ツールではなく、検証用の素朴な変換器。
