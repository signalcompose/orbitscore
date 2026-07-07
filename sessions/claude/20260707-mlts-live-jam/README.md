# 2026-07-07 MLTS ライブジャム（Claude live coding session）

Claude Code が Agent Bridge MCP（#388）経由で OrbitStudio を駆動して行った初のライブコーディングセッションの記録。owner（大和さん）同席・実況付き。同日に完成した live playhead（#390）と ヨレ修正（#389）の実地デモを兼ねる。

## ファイル

| ファイル | 内容 |
|---|---|
| `live_jam.orbs` | ジャム終了時点のエディタバッファ（**演奏された最終状態**・LOOP 行の遷移跡や stale な宣言も演奏の痕跡としてそのまま） |
| `playhead_check.orbs` | 同日先行して playhead 目視確認に使った 2 seq ファイル |

## セット構成（最終ラウンド・実測 5 分 15 秒・自己計測）

| 時間 | ムーブメント | 内容 |
|---|---|---|
| 0:00–0:45 | M1 浮遊 | pad(8s) + arp(0.75s) のみ。裏で 9/8・11/8 レイヤーを仕込み |
| 0:45–1:30 | M2 骨格 | bass(3/4) → kick(4/4) 投入・arp スライス組み替え |
| 1:30–2:47 | M3 変拍子の森 | hat(5/4) + snare(7/8) + open hat(9/8) — 6 メーター共存 |
| 2:47–3:58 | M4 フルカオス | sine blip(11/8) 投入 + tempo 120→132 |
| 3:58–4:42 | M5 ブレイク | 4/4・3/4 の錨を全部抜いた無重力（奇数拍子のみ） |
| 4:42–5:15 | M6 ドロップ→終止 | 全員復帰 → `LOOP()` で断ち切り |

## 使った MLTS（多層時間構造）の道具

- **6 メーター同時**: 3/4 (bass, arp) / 4/4 (drum, pad) / 5/4 (hat) / 7/8 (sn) / 9/8 (oh) / 11/8 (blip)
- **8 時間スケール**: 0.75s（`length(0.5)`）〜 8s（`length(4)`）
- **ネスト最大 4 階層**: `drum.play((1, (1, 1)), 1, (1, (1, (1, 1))), (1, 1))`
- **chop(8) スライス再配列**: arpeggio_c.wav の順列でグリッチ（varispeed 詰め込みでピッチが暴れる）
- **宣言的 LOOP を構成装置に**: グループ列挙の書き換えだけでブレイク/ドロップ

## セッションでの学び（運用メモ）

1. **`LOOP(a, b)` はグループ宣言** — 列挙外の seq は自動停止（spec 明記）。単発 `LOOP(x)` の積み重ねはレイヤー追加にならない（序盤に誤用し owner 指摘で軌道修正）。
2. **MCP `edit_replace` はバッファ編集のみでディスク保存しない** — 演奏後のファイルは dirty のまま。この記録は osascript の Cmd+S 送信で救出した。`save_file`（or `get_document_text`）ツールが #388 の follow-on 候補。
3. 実況スタイル: 「今どうなってる → 何をやりたい → だからこうする」を毎ステップ表示（owner 要望・助言可能性のため）。

## 実行の仕組み

scratchpad の node driver（`playhead_visual_drive.js` の `tool` phase・引数は JSON ファイル渡し）で `edit_replace` → `set_selection` → `run_selection` を刻む。engine は rust daemon（#389 修正後: 150s 実測 mean|dev| 0.52ms）。
