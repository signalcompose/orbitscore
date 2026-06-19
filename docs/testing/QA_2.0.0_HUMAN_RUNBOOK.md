# 2.0.0-dev Human QA Runbook（実機・実音テスト手順）

このファイルは、**プログラムでは検証できない H 項目**（実音・タイミング体感・LinkAudio・Gatekeeper）を yamato が実機で歩くための手順書。各ステップに「コマンド」「期待（聴く/見る）」「記録」を書いた。分類の全体像は [`QA_2.0.0.md`](QA_2.0.0.md)、統括は Epic #278。

> **進め方**: 上から順に。各項目を確認したら下の「記録」のチェックを埋め、不具合は `gh issue create`（`Part of #278`）で子 Issue 化する（FINDING-1 #280 がその例）。`§1` は **#209 不要で今すぐ可能**。`§4b` だけ #209 実装後。

---

## 0. 前提セットアップ（一度だけ）

### 0.1 IAC ドライバを有効化（MIDI の宛先）
1. **Audio MIDI 設定**.app を開く → メニュー「ウインドウ → MIDI スタジオを表示」
2. **IAC ドライバ** をダブルクリック → 「**装置がオンライン**」にチェック → 「バス 1」があることを確認

### 0.2 MIDI 受信先を用意（どちらか）
- **A) ブラウザ MIDI モニタ（ゼロセットアップ・推奨）**
  ```bash
  cd tools/midi-monitor
  python3 -m http.server 8137
  # → Chrome で http://localhost:8137/ を開く
  ```
  画面で「**Enable audio & MIDI**」をクリック → MIDI input で「**IACドライバ バス1**」を選択 → Instrument = Piano。
  ⚠️ Chrome のタブを**前面**に（バックグラウンドだと先頭の音が落ちる）。
- **B) DAW（Logic / Ableton 等）**: ソフト音源トラックの MIDI input を「IAC バス1」にする。

### 0.3 ビルド
```bash
npm run build      # 失敗時は npm run build:clean
```

---

## 1. MIDI / Pitch DSL 実音 QA（examples 11–18）— #209 不要・今すぐ可能

各 example を流して、**音として正しいか**を耳で確認する。共通コマンド:
```bash
npm run midi-run -- examples/NN_xxx.orbs
# RUN もの: 1 回鳴って "(finished)"。Ctrl+C で停止（クリーンな note-off）。
# LOOP もの(17): 鳴り続ける。Ctrl+C で停止。
```

| # | コマンド対象 | 期待（聴く） | 確認する機能 |
|---|---|---|---|
| 11 | `11_midi_degrees.orbs` | **C→E→G→C** の上行アルペジオ（degree 1 3 5 8、C4 始まり） | degree→MIDI / octave / vel |
| 12 | `12_chords_stacks.orbs` | **Cmaj 三和音 → Cm7 → Cm7(add9) → Cm7 を1オクターブ上**。各スロット和音が**同時発音** | `[ ]` stack / chord value / spread / `^N` |
| 13 | `13_scope_chains.orbs` | 同じ三和音形が **D(II)→F→C** と転調、4つ目は**2音が1オクターブ上**。別ch(2)で **C ドリアン**旋律 | `.root()` / `.oct()` / mode |
| 14 | `14_ties_legato.orbs` | 1音目が**2スロット伸びる**（tie、打ち直し無し）、最後の2音が**滑らかに重なる**（legato）。pad の**共通音がチェンジ跨ぎでリング**（hold） | `_` tie / `{ }` legato / `.hold()` |
| 15 | `15_repetition_sections.orbs` | ベースの **riff が反復**、リードの**2小節セクションが2回**（song form） | `*n` / section 変数 |
| 16 | `16_expression.orbs` | 4音が **強→アクセント→弱→スタッカート**（@v / @g の差が聞き分けられる） | `@v` velocity / `@g` articulation |
| 17 | `17_voicing_random.orbs` | **drop2 / invert / open** の voicing 差。**ループごとに両 seq が変化**（`.r` thinning と `Xr`/`^r`）。`Ctrl+C` で停止 | voicing 演算子 / random |
| 18 | `18_voicelead_comp.orbs` | **滑らかな声部進行**（大きな跳躍が無い C→G→Am→F）、別ch で **charleston の comping リズム** | `.voicelead()` / `.comp()` |

**全 example をまとめてスモーク**（parse/schedule の健全性だけを自動判定、音は出るが内容は耳で）:
```bash
scripts/qa-midi-smoke.sh          # 8 passed を期待（要 IAC online）
```

**記録（§1）**
- [ ] 11 正常 / [ ] 12 / [ ] 13 / [ ] 14 / [ ] 15 / [ ] 16 / [ ] 17 / [ ] 18
- 不具合: ____（→ 子 Issue 番号: ____）

---

## 2. Timing / 体感 QA（Disklavier / DAW）

1. §1 と同じ example を **Disklavier か DAW** に送る（IAC 経由）。
2. `seq.midi()` の後に `global.midiLatency(20)` 等を足し、**体感のズレを合わせる**（spec P.1）。

**記録（§2）**
- [ ] タイミング体感に問題なし（midiLatency = ____ ms で調整）
- 気になる点: ____

---

## 3. session-log（`.orbslog`）実セッション QA

`midi-run` は session log を有効化しない。**VS Code 拡張で `.orbs` をライブコーディング**するか、`orbitscore` CLI の play/repl モードで実演奏すると、`enableSessionLog()` 経由で `.orbslog` が生成される。

1. VS Code 拡張で任意の MIDI `.orbs`（例 `examples/12_chords_stacks.orbs`）を開き、エンジンを起動して評価・演奏する。
2. その `.orbs` の**隣に `<basename>.<stamp>.orbslog`** が出来ることを確認。
3. 中身を開き、**meta 行 → 評価レコード → transport(start/stop)** が演奏と一致するか確認（形式は `QA_2.0.0.md` の session-log 節 / SESSION_LOG_SPEC §3）。

**記録（§3）**
- [ ] `.orbslog` が隣に生成される / [ ] 内容が演奏と一致
- 気になる点: ____

---

## 4. LinkAudio QA

### 4a. plugin ↔ Ableton 受信（#209 不要・今できる）
前提: **Ableton Live 12.4+**（Link on）、**OrbitLinkAudio.scx**（Extensions に配置）、**SuperCollider**。

1. SuperCollider で `packages/sc-link-audio/scripts/verify-live-receive.scd` を開いて実行。
2. **期待**: Live に **test-tone / test-sum** が現れて受信される。**Live の BPM を変える**と位相が追従する。
3. ⚠️ **`.scx` が Gatekeeper に弾かれないか**を必ず記録（Apple Silicon、#210）。弾かれて load できない場合は #210 を先に解消。

詳細チェックリスト: [`LINK_AUDIO_E2E_CHECKLIST.md`](LINK_AUDIO_E2E_CHECKLIST.md)。

**記録（§4a）**
- [ ] `.scx` が Gatekeeper を通り load できた（不可なら #210 を起票/参照: ____）
- [ ] verify-live-receive で Live が test-tone/test-sum を受信 / [ ] BPM 変更で位相追従

### 4b. 実 `.orbs` → Link Audio → Ableton（**#209 実装・マージ後**）
1. #209（`orbitPlayBufLink` SynthDef + boot 検出 + `setLinkAudioPluginAvailable(true)`、実装計画は #209 のコメント参照）が入った状態で:
   ```bash
   # SC をブートする通常の実行経路（VS Code 拡張 or orbitscore CLI）で:
   examples/10_link_audio.orbs を実行
   ```
2. **期待**: kick/snare 等のサンプル音が **Link Audio 経由で Ableton の対応チャンネル**に出る（hardware bus に落ちない）。

**記録（§4b・#209 後）**
- [ ] 実 `.orbs` のサンプルが Link Audio で Live に出る

---

## 5. 不具合の記録方法

```bash
gh issue create --title "fix(...): <症状>" --body "Epic #278 / QA で発見。
## 症状 ...
## 再現 ...
Part of #278"
```
- 記録先: [`QA_2.0.0.md`](QA_2.0.0.md) の「人間 QA チェックリスト」にもチェックを反映。
- 既知の finding 例: **#280**（`seq.root(<note-name>)` runtime 拒否）。

---

## 6. リリース（2.0.0）までの残タスク — 全 H 通過後

1. **§1–§4 の実音 QA がすべて OK**（不具合は子 Issue 化 → 対応 or リリースノート明記）
2. **#209 実装・マージ**（SC 環境。実装計画は #209 コメント）
3. **#210**（`.scx` Developer ID re-sign）が必要なら解消
4. **PR #281 をマージ**（QA 基盤）
5. **core spec 同期**（#237）の乖離が無いこと
6. **version bump**: `2.0.0-dev` → `2.0.0`（`packages/engine/src/version.ts` 等）
7. **release CI** を回して `.vsix` を発行

> 1–3 が実機ゲート。4–7 はそれらが揃ってから。current は **§1 から着手可能**。

---

_Last updated: 2026-06-17 (Epic #278 / PR #281 — human QA runbook)_
