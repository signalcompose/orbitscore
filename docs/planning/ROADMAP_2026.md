# OrbitScore Roadmap 2026

**Last updated**: 2026-04-20
**Primary milestone**: ICMC 2026 Hamburg (May 10-16)

---

## 現状 (2026-04-20)

- DSL v3.0 の主要機能は完成 (230 tests passed, 23 skipped)
- SuperCollider (SC 3.14.1) ベースで動作、SC.app の別インストールが必要 (macOS only)
- Paper (camera-ready) 提出済み: SC 前提の実装
- Rust audio daemon の Phase 1 scaffold (TS client) は PR #124 で main に merge 済み
- ICMC 2026 Hamburg 開催まで **約 3 週間**

---

## ゴール設定

ICMC マイルストーンを基準に以下を達成:

1. **ICMC 本番演奏**: 現 SC 経路で安定演奏
2. **`.vsix` 単独インストール**: attendee が当日その場で試せる体験
3. **利用者向け Web ガイド**: VitePress で docs / examples / tutorial
4. **post-ICMC**: MIDI DSL 拡張 → Rust engine 移行の順で v1.1 / v2.0 を計画

---

## Phase / Plan 構造

### v1.0 "ICMC Ready" (Epic #131) — T-20 days

#### Phase 1: scsynth bundle (.vsix 単独インストール)

Sonic Pi パターン (GPL-3.0 aggregation) で scsynth を拡張に同梱し、SC.app 別インストールを不要化。

- 対応子 Issue: #133, #134, #135, #136, #139, #146, #137, #138

**技術方針**:
- bundle 対象: `scsynth` (1.5 MB) + non-supernova plugins (5.1 MB) + `libsndfile.dylib` (5.1 MB) + 必要に応じて `libfftw3f.dylib`
- arm64/x86_64 universal binary で単一 .vsix
- Apple Developer ID で codesign + notarize
- VS Code Marketplace + OpenVSX publish
- 推定 `.vsix` サイズ: 現 3.3 MB → 15-18 MB

**License 整合**:
- OrbitScore 本体: Signal compose Fair Trade License
- bundled scsynth: GPL-3.0 (aggregation、OSC で独立プロセス通信)
- GPL-3.0 §6 corresponding source: SC 公式 GitHub release tag URL 記載
- Sonic Pi 先例 (MIT + bundled GPL scsynth) と同型

#### Phase 2: Documentation site (VitePress)

- 対応子 Issue: #140, #141, #142, #143, #144, #145, #147

**構造**:
- `/guide/getting-started` — install + first patch
- `/guide/tutorial/T1-T8` — 段階的学習
- `/reference/dsl` — DSL syntax 全網羅
- `/theory/mlts` — paper §3 の平易版
- `/examples` — 完成 patch gallery
- GitHub Pages + カスタムドメイン (`orbitscore.signalcompose.com` 想定)

**Tutorial 内訳**:
- T1: Hello Kick
- T2: Layered Beats
- T3: First Polymeter (paper Fig 2)
- T4: Tresillo
- T5: Three Layers (LCM=60, paper §3.4.2)
- T6: Slicing with chop
- T7: Dynamic Layering
- T8: 7-beat polymeter

---

### v1.1 "MIDI Integration" (Epic #132) — post-ICMC

Paper §7.4 Future Directions の "External MIDI Integration" を実装。
Ableton Live / 外部ハードウェアシンセ / ソフトウェアシンセとの同期による演奏体験拡張。

**アーキテクチャ Stage 1 (monorepo engine 抽象化)**:
- `packages/engine-core/` (DSL, parser, scheduler, **EventRouter**) — 分離
- `packages/engine-sc/` (現 SC adapter) — 分離
- `packages/engine-midi/` (MIDI adapter) — 新規
- `packages/engine-rust/` (Rust adapter) — v2.0 で追加

**DSL 拡張**:
- MIDI event syntax (例: `seq.midi(note, vel, ch)` or `seq.out(midi("IAC", 1))`)
- IAC driver (macOS) / 仮想 MIDI bus 自動列挙
- ノート / ベロシティ / CC / プログラムチェンジ対応
- MLTS polymeter を維持したまま MIDI 出力

**なぜ v2.0 Rust engine より先か**:
- Paper reviewer からの期待 (MIDI 対応) を先に満たす
- EventRouter 抽象化が v2.0 の Rust engine 統合を clean にする
- ユーザ価値が明確 (DAW / hw synth 連携 = 音色選択の自由)
- 低リスク (audio path を触らない)

---

### v2.0 "Cross-platform Audio Engine" (Epic #105) — after v1.1

Rust ベースの独自 audio engine に移行し、SC 依存を完全除去。

**スコープ**:
- `packages/engine-rust/` の Rust daemon 機能パリティ完成
  - rate / pan / start_pos / duration / envelope 対応
  - Master gain + mastering chain (fundsp)
- cross-platform binary (macOS arm64/x86_64, Linux x64, Windows x64)
- EventRouter の 1 destination として組み込み (v1.1 の抽象上に乗る)
- SC 経路を fallback に残す期間を経て、最終的に deprecated

**既存 Issue**:
- #105 Epic (更新済)
- #107 orbit-audio-daemon binary
- #108 TS rust-engine client (PR #124 merged、続き v2.0 で)
- #92 time-stretch DSP selection
- #125-130 PR #124 review follow-ups

**Stage 2 fork 戦略 (optional)**:
- `orbitscore-engine-rust` として別 repo に切り出す可能性
- 判断基準: リリース cycle の分離が必要、Rust 側依存が重くなりすぎた場合
- **DSL 本体は fork しない**。engine のみの切り出し

---

## v3.0+ (long-term, #94, #95, #96)

- **Tauri standalone** (#94)
- **VST3/CLAP hosting in Rust** (#95)
- **LLM agent integration** (#96)
- Web版 (WAM、strudel 的)

---

## 決定事項ログ

| 日付 | 決定 | 理由 |
|---|---|---|
| 2026-04-20 | SC 3.14.1 固定 | Homebrew 最新安定版、動作確認済 |
| 2026-04-20 | GPL-3.0 aggregation 方式で scsynth bundle | Sonic Pi 先例、legal 確認済 |
| 2026-04-20 | Apple Developer ID 取得済 (Signal compose) | notarize 必要 |
| 2026-04-20 | Marketplace publisher 新規作成 | Signal compose 名義 |
| 2026-04-20 | Docs 英語メイン | 国際的読者を想定 |
| 2026-04-20 | Plan 1 (MIDI) を Plan 2 (Rust) より先行 | reviewer 期待 + EventRouter 抽象化を先取り |
| 2026-04-20 | monorepo engine 抽象化 Stage 1、fork は Stage 2 optional | DSL は共通、engine のみ切出し可 |

---

## 既存 Issue 整合マップ

| 旧 Issue | 新ポジション | label |
|---|---|---|
| #73 Release workflow | subsumed by #131 (closed) | — |
| #105 Epic Audio Engine | v2.0 (Plan 2) | plan-2-rust, post-icmc |
| #107 orbit-audio-daemon | #105 子 (v2.0) | plan-2-rust, post-icmc |
| #108 TS rust-engine client | #105 子 (v2.0、PR #124 merged) | plan-2-rust, post-icmc |
| #92 time-stretch DSP | #105 子 (v2.0 中盤) | plan-2-rust, post-icmc |
| #94 Tauri standalone | v3.0+ | long-term |
| #95 VST3/CLAP hosting | v3.0+ | long-term |
| #96 LLM agent integration | 別トラック v3.0+ | long-term |
| #125-130 PR #124 followups | v2.0 で消化 | post-icmc |

---

## 3 週間スプリント計画

### Week 1 (Apr 21-27): Phase 1 + VitePress scaffold

- #133 scsynth standalone 検証
- #134 plugin 最小セット決定
- #135 codesign パイプライン設計
- #140 VitePress scaffold
- #141 Getting Started draft

### Week 2 (Apr 28-May 4): Phase 1 実装 + Phase 2 content

- #136 bundle impl
- #139 LICENSE/NOTICE
- #146 first-run check
- #142 Tutorial T1-T8
- #143 DSL Reference
- #144 MLTS Theory

### Week 3 (May 5-9): Publish + Rehearsal

- #137 CI Marketplace publish
- #138 cold-install smoke test
- #147 Marketplace README
- #145 Examples Gallery
- 本番 demo patch 確定

### ICMC (May 10-16)

- 演奏
- attendee への QR 配布 (VitePress サイト)
- feedback 収集

---

## Success Criteria (v1.0)

- [ ] Marketplace で `signalcompose.orbitscore` 公開
- [ ] SC 未インストール macOS で `.vsix` install → example 再生が 3 ステップ以内
- [ ] VitePress サイトが公開されている
- [ ] ICMC attendee が当日 QR から install 完了できる
- [ ] 本番演奏が既存 SC 経路で安定動作 (T-1 日にリハ合格)
