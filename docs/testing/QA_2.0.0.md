# QA Matrix — 2.0.0-dev (v1.1.1 → 2.0.0-dev)

**目的**: v1.1.1 以降の 175 コミットで積まれた新ピラー（MIDI 出力 / Pitch DSL / comp / session log / LinkAudio）の **実機 E2E QA** を、プログラム的に検証できる項目（**P**）と人間・実機でしか確認できない項目（**H**）に分類し、各項目の確認手段・期待結果・spec 参照・状態を一覧化する。

統括: **Epic #278**（開発側統括は #224）。本ファイルは Phase A の成果物（[Issue #279](https://github.com/signalcompose/orbitscore/issues/279)）。

**ベースライン（本マトリクス作成時に確認済 / main @ b4b513d）**:
- `npm test` → **1090 passed | 23 skipped (1113)**, 67 test files passed / 2 skipped
- `npm run build` → 成功（`tsc --build` + engine copy）

---

## 凡例

| 記号 | 意味 |
|---|---|
| **P** | プログラム的に検証可（パース / スケジュール / ファイル内容 / ユニットテスト） |
| **H** | 人間・実機のみ（実音・タイミング体感・DAW / Disklavier / Link 経由の聴感） |
| ✅ | 検証済（このセッションで確認 or 既存ユニットでカバー） |
| ⏳ | 人間 QA 待ち（yamato 実機） |
| 🐛 | finding あり（下記「QA Findings」参照） |

> **重要**: `midi-run` は IAC への送出のみで機械可読ダンプが無い。プログラム的にできるのは「クラッシュ・degree 拒否なくパース → degree 解決 → スケジュール → IAC ポート確保まで到達するか」の**スモーク**まで。MIDI の**内容**（正しい音が鳴るか）は人間観測（H）。timing/degree/voicing の算術的正しさは既存 1090 ユニットがカバー済みなので、そこは再導出しない。

---

## プログラムスモーク結果（example → `midi-run`）

`scripts/qa-midi-smoke.sh` が各 example を実エンジン経路（parser → degree 解決 → MidiScheduler → MidiOutput → IAC）に通す。**SuperCollider 不要**。

PASS 判定は4条件: ①`▶ running … → IAC` 到達（parse/statement 健全）②`midi-run error:` 無し ③**握り潰しエラートークン無し** ④**期待数のシーケンスがスケジュールされた証拠**（`(one-shot)` / `loop queued` / `loop started` の数 ≥ そのファイルの RUN/LOOP が指すシーケンス数）。

③④が重要 — `→ IAC` は statement ループ後・scheduler tick 前に出力され、degree→note の解決は tick 時（最終出力段）で起きる。さらにエンジンは多くの失敗を**握り潰して継続する**: MidiScheduler は失敗 tick を `console.error` してループ継続、インタプリタは「変数/シーケンス/global 不在」「メソッド不明」「RUN/LOOP が存在しないシーケンス名」等を throw せず `console.error` して継続する。よって `→ IAC` 単独・あるいは `midi-run error:` 無しだけでは、**部分破損（健全な seq + 壊れた seq の混在）**を見逃す。③ はこれらの silent-error 文字列（`MidiScheduler: action failed` / `scheduler not running` / `loop scheduling error:` / `do not exist and will be ignored` / `Variable not found:` / `Sequence instance not found:` / `Global instance not found:` / `Method not found:` / `Transport target not found:` / `No global instance available` / `requires a global`）を全て検出し、④ はシーケンスが silent にドロップされていないことを数で保証する。ネガティブテスト（`global.start()` 欠落、および RUN が存在しない seq を指す部分破損）で本判定が FAIL することを確認済。スクリプトは `midi-run` を ts-node 直接起動し、SIGINT がグレースフル shutdown に届く（鳴りっぱなし MIDI / 孤児プロセスを残さない）。

| example | 対象ピラー | スモーク |
|---|---|---|
| `examples/11_midi_degrees.orbs` | MIDI 出力（degree → MIDI, `midi`/`octave`/`vel`/`key`/`RUN`） | ✅ PASS |
| `examples/12_chords_stacks.orbs` | Phase 3: `[ ]` stack / bare `[ ]` chord value / `import chords` / spread `[m7,9]` / `(m7^+1)` | ✅ PASS |
| `examples/13_scope_chains.orbs` | Phase 2 + E6: `.root()`（数値/note-name 群）/ `.oct()` / `.mode()` lattice | ✅ PASS 🐛 |
| `examples/14_ties_legato.orbs` | Phase 4: `_` event tie / `{ }` legato / `.hold()` common-tone tie | ✅ PASS |
| `examples/15_repetition_sections.orbs` | Phase R + E4: `*n` / pattern 変数 / `,` multi-cell section | ✅ PASS |
| `examples/16_expression.orbs` | E5: `@v` 絶対/相対 velocity / `@g` articulation | ✅ PASS |
| `examples/17_voicing_random.orbs` | E2/§12: `.drop()/.invert()/.open()` / `Xr` / `.r` / `^r` | ✅ PASS |
| `examples/18_voicelead_comp.orbs` | comp C1/C2a: `.voicelead()` / `.cell().comp()` | ✅ PASS |

**実行**: `scripts/qa-midi-smoke.sh`（要 IAC ポート online、リポジトリルートから）。結果: **8 passed, 0 failed**。

---

## インベントリ別マトリクス

### 1. MIDI 出力（Phase 1, #228）

| 機能 | 区分 | 確認手段 | 期待結果 | spec | 状態 |
|---|---|---|---|---|---|
| `seq.midi(port, ch)` で MIDI 化 / port 解決 | P/H | smoke 11 / ユニット `tests/midi/midi-output.spec.ts` | IAC ポート確保、degree が note に解決 | P.1 / §1 | ✅ |
| degree → MIDI note 解決（IONIAN + 臨時記号） | P | ユニット `tests/midi/*`, `tests/core/sequence-midi-dispatch.spec.ts` | 60=C4 等の算術 | P.2 / §2.1 | ✅ |
| `octave()` / `vel()` / `gate()` / `key()` / `midiLatency()` | P | smoke 11 / ユニット | 既定値・上書きが反映 | P.1 | ✅ |
| MidiScheduler lookahead / note tracking / panic | P | ユニット `tests/midi/midi-scheduler.spec.ts`, `tests/core/midi-hanging-note-invariant.spec.ts` | note-off 漏れ無し、stop で CC123/120 | P.10 / §7 | ✅ |
| degree → **実音**（monitor / DAW で聴く） | H | 実機: IAC → monitor synth or DAW | C major arpeggio 等が**正しい音**で鳴る | — | ⏳ |
| MIDI → Disklavier / DAW の timing 体感 | H | 実機 | 体感ズレ無し（`midiLatency` で調整） | — | ⏳ |

### 2. Pitch DSL — E1–E6 / Phase 3·4·R

| 機能 | 区分 | 確認手段 | 期待結果 | spec | 状態 |
|---|---|---|---|---|---|
| E1: bare `[ ]` chord-value literal | P | smoke 12 / `tests/core/sequence-chord-dispatch.spec.ts` | `[m7]` → C Eb G Bb 等 | P.7 §6 / #48 | ✅ |
| E2: voicing 演算子 `.drop/.invert/.open/.close/.shell/.rootless` | P | smoke 17（`.drop/.invert/.open/.r`）/ ユニット `tests/midi/voicing.spec.ts`（`.close/.shell/.rootless` を含む全演算子） | 各 voicing の決定論的 octave 配置 | P.11 §12 | ✅ |
| E2: random `Xr` / `.r` / `^r`（per-cycle 再ロール） | P | smoke 17 / ユニット | パース・スケジュール（毎サイクル再ロール） | P.11 / #53 | ✅ |
| E3: key-center register `global.key("D4")` | P | ユニット | tonic + 基準オクターブ設定 | P.1 / #253 | ✅ |
| E4: section 変数（`,` multi-bar） | P | smoke 15 / `tests/core/sequence-pattern-dispatch.spec.ts` | `play(A,A)` で section 再利用 | P.9 / #254 | ✅ |
| E5: per-note `@v` velocity / `@g` articulation | P | smoke 16 / ユニット | 絶対/相対 velocity・gate% が反映 | P.12 / #262 | ✅ |
| E6: mode scope `mode(...)` + `.mode(name)` + `.period()` | P | smoke 13（`.mode`）/ ユニット `tests/midi/mode.spec.ts`（`.period()` を含む） | lattice index で degree 解決 | P.4 / #264 | ✅ |
| Phase 2: scope chains `.root()/.mode()/.oct()` | P | smoke 13 / `tests/core/sequence-scope-dispatch.spec.ts` | inner→outer→seq 既定の解決順 | P.5 §3 | ✅ 🐛 |
| Phase 3: `[ ]` stack 同時 note-on / spread / `-N` / `^N` | P | smoke 12 / `tests/core/sequence-stack-dispatch.spec.ts`（stack）+ `tests/core/sequence-chord-dispatch.spec.ts`（`-N` 除去・spread・`^N`） | 同時発音・spread・除去・octave 移動 | P.6/P.7 | ✅ |
| Phase 4: `_` tie / `_n` voice tie / `{ }` legato / `.hold()` | P | smoke 14 / `tests/core/sequence-tie-legato-dispatch.spec.ts` | retrigger 抑制・overlap・common-tone tie | P.8 §5 | ✅ |
| Phase R: `*n` repetition / pattern 変数 / unbound→rest | P | smoke 15 / ユニット, #255 | n スロット占有・splice・slot 保持 | P.9 §6.5 | ✅ |
| 上記すべての **実音の正しさ**（和音・voicing・key・expression・mode） | H | 実機: IAC → monitor/DAW | 音として正しい（drop2 が drop2 に聞こえる 等） | — | ⏳ |

### 3. comp（C1 / C2a）

| 機能 | 区分 | 確認手段 | 期待結果 | spec | 状態 |
|---|---|---|---|---|---|
| C1: auto voice-leading `.voicelead()` / `.vl()` | P | smoke 18 / `tests/midi/voice-leading.spec.ts` | 連続和音を最小 voice 移動で接続（B が 1oct 下 等） | P.13 §6.3 / #269 | ✅ |
| C2a: comping rhythm `.comp()` / `.cell()` / `.density()` | P | smoke 18 / `tests/midi/comp.spec.ts` | cell ごとの onset、N chords→N bars | P.14 §6.4 / #271 | ✅ |
| comp の **groove**（実音のノリ） | H | 実機: IAC → DAW | comping が音楽的に機能 | — | ⏳ |

### 4. session log（`.orbslog` L1, #229）

| 機能 | 区分 | 確認手段 | 期待結果 | spec | 状態 |
|---|---|---|---|---|---|
| meta + preamble + 評価レコードの三重スタンプ JSONL | P | ユニット `tests/session-log/session-log-writer.spec.ts`（13 件） | logVersion/engine/dsl meta → preamble（transport=null）→ 評価（wall/transport/effect） | SESSION_LOG_SPEC §1/§3 | ✅ |
| 原子的 create（start で即ファイル生成、start 前は inert） | P | 上記ユニット + 実ファイル probe（本セッション確認） | start 前 `getFilePath()===null`、start 直後にファイル存在 | §3.1 | ✅ |
| 命名 `<basename>.<stamp>.orbslog` / 衝突カウンタ / 再start=新ファイル | P | ユニット | 規約どおりの命名・衝突回避 | §3 | ✅ |
| best-effort（open 失敗で再生継続・throw しない） | P | ユニット（"flight recorder must not break playback"） | logging 無効化のみ、再生継続 | §1 | ✅ |
| 実セッションでの `.orbslog` 生成（CLI play/repl 経路） | H/P | `play-mode.ts`/`repl-mode.ts` が `enableSessionLog()` を呼ぶ。実機 live coding で生成確認 | 実演奏で `.orbslog` が隣に出力 | §3 | ⏳ |

> 実 on-disk 形式は本セッションで probe 生成し spec 一致を確認（meta → 評価レコード〔preamble, transport=null〕 → transport start → 評価レコード〔triple stamp〕 → stop）。`midi-run` 経路は session log を**有効化しない**（CLI play/repl 経路でのみ有効）。

### 5. LinkAudio（Epic #187 / Step 4）

| 機能 | 区分 | 確認手段 | 期待結果 | spec | 状態 |
|---|---|---|---|---|---|
| engine: `Global.linkAudio()` / `Sequence.output()` / channel registry / hardware fallback | P | ユニット `tests/audio/link-audio-channels.spec.ts`, `tests/audio-parser/*` | name→channelId 解決、未配線時 hardware fallback | WCTM/LinkAudio | ✅ |
| VS Code 拡張: LinkAudio syntax / completion / diagnostic | P | ユニット `tests/vscode-extension/diagnostics-analysis.spec.ts` | 空 `.output("")` フラグ等 | Step 3.3 | ✅ |
| plugin / UGen（`OrbitLinkAudioOut`, per-channel sum, `.scx` build） | P/H | build 済 `.scx`。`packages/sc-link-audio/scripts/verify-plugin.scd` | plugin load・UGen 動作 | Step 2 | ⏳ |
| **#209 未配線**: `orbitPlayBufLink` SynthDef + boot 検出 + `setLinkAudioPluginAvailable(true)` | P | **本 Epic Phase #209 で実装**（別 PR） | 実 `.orbs` のサンプル再生が Link Audio 経路を選択 | #209 | ⛔ 未実装 |
| plugin↔Ableton 受信（test-tone / test-sum / テンポ位相追従） | H | `packages/sc-link-audio/scripts/verify-live-receive.scd` | Live に test-tone/test-sum 受信、BPM 変更で追従 | `docs/testing/LINK_AUDIO_E2E_CHECKLIST.md` | ⏳ |
| #209 後: 実 `.orbs`（`examples/10_link_audio.orbs`）→ Link Audio → Ableton | H | 実機 E2E | サンプル音が Live のチャンネルに出る | #209 | ⏳ |
| `.scx` の Gatekeeper load（Apple Silicon、#210 関連） | H | 実機 | Gatekeeper に弾かれず load | #210 | ⏳ |

### 6. その他

| 機能 | 区分 | 確認手段 | 期待結果 | spec | 状態 |
|---|---|---|---|---|---|
| scheduler quantize（LOOP startup / play() を小節境界へ） | P | ユニット, #212 | 小節境界スナップ | #212 | ✅ |
| audioPath search resolution + sample bank lookup | P | ユニット, #221 | 相対パス解決 | #221 | ✅ |

---

## QA Findings

### FINDING-1 🐛: `seq.root(<note-name>)`（シーケンスレベル note-name root）が runtime で拒否される

- **症状**: `lead.root(C)` のようにシーケンス既定 root を **note-name トークン**で指定すると、runtime で `Sequence 'lead': root() degree must be a positive integer (1+), got C. Degree 0 is a rest, not a valid root.` が throw される。
- **対比**: **グループレベルの note-name root は動作する**（`(1,3,5).root(C)` / `.root(F)` は parse + runtime とも OK、`examples/13` で確認）。数値の `seq.root(1)` も OK。パース自体は `s.root(C)` も通る（拒否は runtime）。
- **spec との乖離**: `INSTRUCTION_ORBITSCORE_DSL.md` P.5（行 862）は `seq.root(C)` を note-name トークンの**シーケンス既定**として記載。実装はシーケンスレベルで note-name を受け付けない。
- **影響**: 小（回避策あり: グループレベル note root か `seq.root(<degree>)`）。ただし spec が正本なので、実装 or spec のどちらかを直す必要。
- **暫定対応**: `examples/13_scope_chains.orbs` は `seq.root(1)`（数値）+ グループ note root で記述し、コメントで本 finding に言及。
- **要対応**: **子 Issue #280 起票済**（実装をシーケンスレベル note-name root に対応させる、または spec を「note root はグループのみ」に修正する。判断は #237 core spec sync と連動）。

---

## 人間 QA チェックリスト（H 項目 / yamato 実機）

> このチェックリストは Phase C「学習サイト walkthrough」（`sites/user/`）に取り込み、「歩けば全機能に触れる」形にする。各 example を `npm run midi-run -- <file>` で再生し、IAC を monitor synth か DAW で受ける。

- [ ] **MIDI 基本** (`11`): C-E-G-C のアルペジオが正しい音で鳴る。`midiLatency` でタイミング調整。
- [ ] **和音/stack** (`12`): Cmaj 三和音 → Cm7 → Cm7add9 → Cm7(+1oct) が和音として正しい。
- [ ] **scope/mode** (`13`): 同じ形が II/F/C/oct で転調。Dorian melody が正しい旋法で聞こえる。
- [ ] **tie/legato** (`14`): 音1が2スロット持続、最後の2音が slur、pad の共通音がリング。
- [ ] **repetition/section** (`15`): riff の反復、section の song-form 再利用が聞こえる。
- [ ] **expression** (`16`): velocity 強弱と staccato が聞き分けられる。
- [ ] **voicing/random** (`17`): drop2/invert/open の差、ループごとの random 変化。
- [ ] **voicelead/comp** (`18`): 滑らかな声部進行と comping のノリ。
- [ ] **session log**: 実 live coding（CLI play/repl）で `.orbslog` が隣に生成され、内容が演奏と一致。
- [ ] **LinkAudio**（#209 実装後）: `verify-live-receive.scd` で Live 受信 → `examples/10_link_audio.orbs` の音が Link Audio で Ableton に出る（前提: `.scx` が Gatekeeper を通る、#210）。

---

## プログラム再現手順

```bash
npm run build                 # tsc --build + engine copy
npm test                      # 1090 passed | 23 skipped（回帰ガード）
scripts/qa-midi-smoke.sh      # 新 MIDI example 8 件の parse/schedule スモーク（要 IAC online）
```

---

_Last updated: 2026-06-17 (Epic #278 Phase A, Issue #279)_
