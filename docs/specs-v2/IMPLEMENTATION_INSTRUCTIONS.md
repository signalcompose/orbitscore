<div id="title-block-header" class="header">

<div class="docmeta">

{"type":"meta","doc":"IMPLEMENTATION_INSTRUCTIONS","for":"Claude Code (Opus 4.8)","deadline":"RETARGET — Geidai cancelled; ICLC TBD (see \#413)","stages":"note-DSL → record → WCTM"}

</div>

</div>

# Implementation Instructions — OrbitScore v1.1 + Session Log + WCTM

<div style="border:2px solid #B4231F;background:#FFF3F2;color:#16181D;padding:12px 16px;margin:16px 0;border-radius:4px;">

**⚠️ 前提変更（2026-07-12・統括 [\#413](https://github.com/signalcompose/orbitscore/issues/413)）**\
藝大コンサート（2026-08-07）は**不採択**。旧「Hard deadline 2026-08-07・逆算で全工程が決まる」の前提は失効。本番トラックは **ICLC への proposal 提出方向へ retarget**（年次・提出日 ≈8/15・提出形態 work / work+paper はいずれも**要確認**）。**Max 縛りも消滅**（必須ではない。使わないという意味ではない）。\
以下の週次計画（W1–W6 / SPReAD 7/3 / リハ#1）と工程は**藝大版のスナップショット**。ICLC 向けの再計画は統括 \#413 に deferred（本書では再議論しない）。Stage 1（Pitch DSL）は締切と独立に実装済み。

</div>

**For**: Claude Code (Opus 4.8) working in `signalcompose/orbitscore` **Companion specs**(正本。本書は作業手順・委譲方針・既知文脈): PITCH_DSL_SPEC_v1.1 / SESSION_LOG_SPEC_v1 / WCTM_SYSTEM_SPEC_v1 / DESIGN_DISCUSSION_RECORD **Date**: 2026-06-12 **Hard deadline**: ~~2026-08-07 コンサート本番(WCTM)。逆算で全工程が決まる。~~（藝大不採択で失効 — 冒頭の前提変更ノート / \#413 参照）

------------------------------------------------------------------------

## 1. Scope and Stage Order

スコープは3段: **Stage 1 = note DSL(ピッチ/MIDI)→ Stage 2 = 記録 → Stage 3 = WCTM**。ただし依存関係により一部は同乗・並行する。下図が正。

![](data:image/svg+xml;base64,PHN2ZyB2aWV3Ym94PSIwIDAgOTIwIDQyMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiByb2xlPSJpbWciIGFyaWEtbGFiZWw9IuWun+ijheS+neWtmOOCsOODqeODleOBqOmAseasoeioiOeUuyIgc3R5bGU9Im1heC13aWR0aDoxMDAlO2hlaWdodDphdXRvO2ZvbnQtZmFtaWx5OiYjMzk7SGlyYWdpbm8gU2FucyYjMzk7LCYjMzk7WXUgR290aGljJiMzOTssc2Fucy1zZXJpZjsiPgogIDxkZWZzPgogICAgPG1hcmtlciBpZD0iZGEiIHZpZXdib3g9IjAgMCAxMCAxMCIgcmVmeD0iOSIgcmVmeT0iNSIgbWFya2Vyd2lkdGg9IjYuNSIgbWFya2VyaGVpZ2h0PSI2LjUiIG9yaWVudD0iYXV0by1zdGFydC1yZXZlcnNlIj4KICAgICAgPHBhdGggZD0iTTAsMCBMMTAsNSBMMCwxMCB6IiBmaWxsPSIjMTYxODFEIiAvPgogICAgPC9tYXJrZXI+CiAgPC9kZWZzPgogIDxzdHlsZT4KICAgIC5waHtmaWxsOiNGRkZGRkY7c3Ryb2tlOiMxNjE4MUQ7c3Ryb2tlLXdpZHRoOjEuNDt9CiAgICAucGhSe2ZpbGw6I0ZGRjNGMjtzdHJva2U6I0I0MjMxRjtzdHJva2Utd2lkdGg6MS40O30KICAgIC5waE97ZmlsbDojRjJGMkVGO3N0cm9rZTojOUE5QUEwO3N0cm9rZS13aWR0aDoxLjI7fQogICAgLnR7Zm9udC1zaXplOjEzcHg7ZmlsbDojMTYxODFEO2ZvbnQtd2VpZ2h0OjYwMDt9CiAgICAuc3tmb250LXNpemU6MTAuNXB4O2ZpbGw6IzVBNUE2MDt9CiAgICAuZXtzdHJva2U6IzE2MTgxRDtzdHJva2Utd2lkdGg6MS4yO2ZpbGw6bm9uZTt9CiAgICAud2t7Zm9udC1zaXplOjEwcHg7ZmlsbDojOUE5QUEwO2xldHRlci1zcGFjaW5nOi4wNmVtO30KICAgIC53a2x7c3Ryb2tlOiNFNEU0RTA7c3Ryb2tlLXdpZHRoOjE7fQogIDwvc3R5bGU+CiAgPCEtLSB3ZWVrIGJhbmRzIC0tPgogIDxsaW5lIHgxPSIyMCIgeTE9IjM0IiB4Mj0iMjAiIHkyPSI0MDAiIGNsYXNzPSJ3a2wiPjwvbGluZT48dGV4dCB4PSIyNCIgeT0iMzAiIGNsYXNzPSJ3ayI+VzEgKDYvMTUtKTwvdGV4dD4KICA8bGluZSB4MT0iMTkwIiB5MT0iMzQiIHgyPSIxOTAiIHkyPSI0MDAiIGNsYXNzPSJ3a2wiPjwvbGluZT48dGV4dCB4PSIxOTQiIHk9IjMwIiBjbGFzcz0id2siPlcyPC90ZXh0PgogIDxsaW5lIHgxPSIzNDAiIHkxPSIzNCIgeDI9IjM0MCIgeTI9IjQwMCIgY2xhc3M9IndrbCI+PC9saW5lPjx0ZXh0IHg9IjM0NCIgeT0iMzAiIGNsYXNzPSJ3ayI+VzMg4oC7U1BSZUFEIDcvMzwvdGV4dD4KICA8bGluZSB4MT0iNDkwIiB5MT0iMzQiIHgyPSI0OTAiIHkyPSI0MDAiIGNsYXNzPSJ3a2wiPjwvbGluZT48dGV4dCB4PSI0OTQiIHk9IjMwIiBjbGFzcz0id2siPlc0PC90ZXh0PgogIDxsaW5lIHgxPSI2MjAiIHkxPSIzNCIgeDI9IjYyMCIgeTI9IjQwMCIgY2xhc3M9IndrbCI+PC9saW5lPjx0ZXh0IHg9IjYyNCIgeT0iMzAiIGNsYXNzPSJ3ayI+VzU8L3RleHQ+CiAgPGxpbmUgeDE9IjczMCIgeTE9IjM0IiB4Mj0iNzMwIiB5Mj0iNDAwIiBjbGFzcz0id2tsIj48L2xpbmU+PHRleHQgeD0iNzM0IiB5PSIzMCIgY2xhc3M9IndrIj5XNiDjg6rjg48jMTwvdGV4dD4KICA8bGluZSB4MT0iODMwIiB5MT0iMzQiIHgyPSI4MzAiIHkyPSI0MDAiIGNsYXNzPSJ3a2wiPjwvbGluZT48dGV4dCB4PSI4MzQiIHk9IjMwIiBjbGFzcz0id2siPlc3LTgg4oaSIDgvNzwvdGV4dD4KCiAgPCEtLSBTdGFnZTEgcm93IC0tPgogIDxyZWN0IHg9IjI4IiB5PSI1MCIgd2lkdGg9IjEzMCIgaGVpZ2h0PSI1MiIgY2xhc3M9InBoIiAvPgogIDx0ZXh0IHg9IjM4IiB5PSI3MCIgY2xhc3M9InQiPlBoYXNlIDAg5qSc6Ki8PC90ZXh0PgogIDx0ZXh0IHg9IjM4IiB5PSI4NiIgY2xhc3M9InMiPuS4pue9ri9xdWFudGl6ZS9NSURJL0xpbms8L3RleHQ+CiAgPHJlY3QgeD0iMjgiIHk9IjEyMCIgd2lkdGg9IjEzMCIgaGVpZ2h0PSI0NiIgY2xhc3M9InBoIiAvPgogIDx0ZXh0IHg9IjM4IiB5PSIxNDAiIGNsYXNzPSJ0Ij5QaGFzZSBSPC90ZXh0PgogIDx0ZXh0IHg9IjM4IiB5PSIxNTYiIGNsYXNzPSJzIj4qbiArIOODkeOCv+ODvOODs+WkieaVsDwvdGV4dD4KICA8cmVjdCB4PSIxOTgiIHk9IjUwIiB3aWR0aD0iMTMwIiBoZWlnaHQ9IjUyIiBjbGFzcz0icGgiIC8+CiAgPHRleHQgeD0iMjA4IiB5PSI3MCIgY2xhc3M9InQiPlBoYXNlIDEgTUlESTwvdGV4dD4KICA8dGV4dCB4PSIyMDgiIHk9Ijg2IiBjbGFzcz0icyI+SUFDL25vdGXnrqHnkIYvwqc3LTA8L3RleHQ+CiAgPHJlY3QgeD0iMzQ4IiB5PSI1MCIgd2lkdGg9IjEzMCIgaGVpZ2h0PSI0NiIgY2xhc3M9InBoIiAvPgogIDx0ZXh0IHg9IjM1OCIgeT0iNzAiIGNsYXNzPSJ0Ij5QaGFzZSAyIC5yb290KCk8L3RleHQ+CiAgPHRleHQgeD0iMzU4IiB5PSI4NiIgY2xhc3M9InMiPuOCueOCs+ODvOODly/pn7PlkI08L3RleHQ+CiAgPHJlY3QgeD0iNDk4IiB5PSI1MCIgd2lkdGg9IjExMCIgaGVpZ2h0PSI0NiIgY2xhc3M9InBoIiAvPgogIDx0ZXh0IHg9IjUwOCIgeT0iNzAiIGNsYXNzPSJ0Ij5QaGFzZSAzPC90ZXh0PgogIDx0ZXh0IHg9IjUwOCIgeT0iODYiIGNsYXNzPSJzIj5bIF0vY2hvcmQvc3ByZWFkPC90ZXh0PgogIDxyZWN0IHg9IjczOCIgeT0iNTAiIHdpZHRoPSI4MCIgaGVpZ2h0PSI0NiIgY2xhc3M9InBoTyIgLz4KICA8dGV4dCB4PSI3NDYiIHk9IjcwIiBjbGFzcz0idCI+UGhhc2UgNDwvdGV4dD4KICA8dGV4dCB4PSI3NDYiIHk9Ijg2IiBjbGFzcz0icyI+5L2Z5Yqb5pmCPC90ZXh0PgoKICA8IS0tIFN0YWdlMiByb3cgLS0+CiAgPHJlY3QgeD0iMTk4IiB5PSIxMjAiIHdpZHRoPSIxMzAiIGhlaWdodD0iNDYiIGNsYXNzPSJwaFIiIC8+CiAgPHRleHQgeD0iMjA4IiB5PSIxNDAiIGNsYXNzPSJ0Ij5MMSDjg63jgrDmm7jlh7rjgZc8L3RleHQ+CiAgPHRleHQgeD0iMjA4IiB5PSIxNTYiIGNsYXNzPSJzIj5QaGFzZSAxIOOBq+WQjOS5lzwvdGV4dD4KICA8cmVjdCB4PSI4MzgiIHk9IjEyMCIgd2lkdGg9Ijc0IiBoZWlnaHQ9IjQ2IiBjbGFzcz0icGhPIiAvPgogIDx0ZXh0IHg9Ijg0NiIgeT0iMTQwIiBjbGFzcz0idCI+TDI8L3RleHQ+CiAgPHRleHQgeD0iODQ2IiB5PSIxNTYiIGNsYXNzPSJzIj7mnKznlarlvow8L3RleHQ+CgogIDwhLS0gU3RhZ2UzIHJvdyAtLT4KICA8cmVjdCB4PSIzNDgiIHk9IjIwMCIgd2lkdGg9IjEzMCIgaGVpZ2h0PSI1MiIgY2xhc3M9InBoUiIgLz4KICA8dGV4dCB4PSIzNTgiIHk9IjIyMCIgY2xhc3M9InQiPlcxOiBCcmlkZ2UgTUNQPC90ZXh0PgogIDx0ZXh0IHg9IjM1OCIgeT0iMjM2IiBjbGFzcz0icyI+M+ODhOODvOODqyvmpJzoqLw8L3RleHQ+CiAgPHJlY3QgeD0iNDk4IiB5PSIyMDAiIHdpZHRoPSIxMTAiIGhlaWdodD0iNTIiIGNsYXNzPSJwaFIiIC8+CiAgPHRleHQgeD0iNTA4IiB5PSIyMjAiIGNsYXNzPSJ0Ij5XMjogcGkg6aqo5qC8PC90ZXh0PgogIDx0ZXh0IHg9IjUwOCIgeT0iMjM2IiBjbGFzcz0icyI+6JaE44GE44K544Kx44Or44OI44OzPC90ZXh0PgogIDxyZWN0IHg9IjYyOCIgeT0iMjAwIiB3aWR0aD0iOTAiIGhlaWdodD0iNTIiIGNsYXNzPSJwaFIiIC8+CiAgPHRleHQgeD0iNjM2IiB5PSIyMjAiIGNsYXNzPSJ0Ij5XMzog6Ieq5b6LPC90ZXh0PgogIDx0ZXh0IHg9IjYzNiIgeT0iMjM2IiBjbGFzcz0icyI+44Or44O844OXK+S7i+WKqTwvdGV4dD4KICA8cmVjdCB4PSI3MzgiIHk9IjIwMCIgd2lkdGg9IjgwIiBoZWlnaHQ9IjUyIiBjbGFzcz0icGhSIiAvPgogIDx0ZXh0IHg9Ijc0NiIgeT0iMjIwIiBjbGFzcz0idCI+56K65a6aPC90ZXh0PgogIDx0ZXh0IHg9Ijc0NiIgeT0iMjM2IiBjbGFzcz0icyI+44OR44Op44Oh44O844K/5a6f5risPC90ZXh0PgogIDxyZWN0IHg9IjgzOCIgeT0iMjAwIiB3aWR0aD0iNzQiIGhlaWdodD0iNTIiIGNsYXNzPSJwaFIiIC8+CiAgPHRleHQgeD0iODQ2IiB5PSIyMjAiIGNsYXNzPSJ0Ij7kvJrloLQ8L3RleHQ+CiAgPHRleHQgeD0iODQ2IiB5PSIyMzYiIGNsYXNzPSJzIj7moKHmraMv6YCa44GXPC90ZXh0PgoKICA8IS0tIEh1bWFuL01heCBwYXJhbGxlbCB0cmFjayAtLT4KICA8cmVjdCB4PSIxOTgiIHk9IjMwMCIgd2lkdGg9IjI4MCIgaGVpZ2h0PSI1MiIgY2xhc3M9InBoTyIgLz4KICA8dGV4dCB4PSIyMDgiIHk9IjMyMCIgY2xhc3M9InQiPk1heCDjg5Hjg4Pjg4Eo5Lq66ZaT5Li75bCO44O75Lim6KGMKTwvdGV4dD4KICA8dGV4dCB4PSIyMDgiIHk9IjMzNiIgY2xhc3M9InMiPuWFpeWKm+OCu+ODs+OCt+ODs+OCsCtMaW5r6aeG5YuVIC8g5Ye65Yqb44Or44O844OG44Kj44Oz44KwPC90ZXh0PgogIDxyZWN0IHg9IjYyOCIgeT0iMzAwIiB3aWR0aD0iMTkwIiBoZWlnaHQ9IjUyIiBjbGFzcz0icGhPIiAvPgogIDx0ZXh0IHg9IjYzNiIgeT0iMzIwIiBjbGFzcz0idCI+44K544Kt44OrOiBBVFRZQSAub3JiczwvdGV4dD4KICA8dGV4dCB4PSI2MzYiIHk9IjMzNiIgY2xhc3M9InMiPivmvJTlpY/mjIfnpLrmm7goVzYg44Oq44OP44Gn5qSc6Ki8KTwvdGV4dD4KCiAgPCEtLSBlZGdlcyAtLT4KICA8cGF0aCBjbGFzcz0iZSIgZD0iTTE1OCw3NiBMMTkyLDc2IiBtYXJrZXItZW5kPSJ1cmwoI2RhKSIgLz4KICA8cGF0aCBjbGFzcz0iZSIgZD0iTTE1OCwxNDMgTDE5MiwxNDMiIG1hcmtlci1lbmQ9InVybCgjZGEpIiAvPgogIDxwYXRoIGNsYXNzPSJlIiBkPSJNMzI4LDc2IEwzNDIsNzYiIG1hcmtlci1lbmQ9InVybCgjZGEpIiAvPgogIDxwYXRoIGNsYXNzPSJlIiBkPSJNNDc4LDczIEw0OTIsNzMiIG1hcmtlci1lbmQ9InVybCgjZGEpIiAvPgogIDxwYXRoIGNsYXNzPSJlIiBkPSJNMjYzLDEwMiBMMjYzLDExNCIgbWFya2VyLWVuZD0idXJsKCNkYSkiIC8+CiAgPHBhdGggY2xhc3M9ImUiIGQ9Ik0zMjgsMTQzIEwzODAsMTQzIEw0MDUsMjAwIiBtYXJrZXItZW5kPSJ1cmwoI2RhKSIgLz4KICA8cGF0aCBjbGFzcz0iZSIgZD0iTTQ3OCwyMjYgTDQ5MiwyMjYiIG1hcmtlci1lbmQ9InVybCgjZGEpIiAvPgogIDxwYXRoIGNsYXNzPSJlIiBkPSJNNjA4LDIyNiBMNjIyLDIyNiIgbWFya2VyLWVuZD0idXJsKCNkYSkiIC8+CiAgPHBhdGggY2xhc3M9ImUiIGQ9Ik03MTgsMjI2IEw3MzIsMjI2IiBtYXJrZXItZW5kPSJ1cmwoI2RhKSIgLz4KICA8cGF0aCBjbGFzcz0iZSIgZD0iTTgxOCwyMjYgTDgzMiwyMjYiIG1hcmtlci1lbmQ9InVybCgjZGEpIiAvPgogIDxwYXRoIGNsYXNzPSJlIiBkPSJNNjA4LDk2IEw2NDAsMTQwIEw2NjAsMjAwIiBtYXJrZXItZW5kPSJ1cmwoI2RhKSIgLz4KICA8cGF0aCBjbGFzcz0iZSIgZD0iTTQ3OCwzMjYgTDUyMCwzMDAgTDU0MCwyNTIiIG1hcmtlci1lbmQ9InVybCgjZGEpIiBzdHJva2UtZGFzaGFycmF5PSIzIDMiIC8+Cjwvc3ZnPg==)

要点: **L1 は Phase 1 に同乗**(評価経路の傍受点が同一、かつ Bridge の `get_session_tail` が L1 に依存)。**WCTM Bridge は Phase 2 完了を待たず評価経路+特徴量で着手可**。Phase 4(タイ/hold)・L2(リプレイヤー)・Phase 5(mode)は本番のクリティカルパス外。Max パッチとスキルは人間主導の並行トラック。

## 2. Repository Context (調査済み事実)

- ROADMAP_2026.md の v1.1 “MIDI Integration”(Epic \#132)が Stage 1 の親。EventRouter は 2026-06 時点で未実装(grep 確認済み)。
- パッケージ: `packages/engine`(supercolliderjs, uuid, wavefile, ws / Node 22 / CommonJS)、`packages/sc-link-audio`、`packages/vscode-extension`。
- LinkAudio 統合(Epic \#187)は直近の完了作業。`docs/research/LINK_AUDIO_API.md` に設計決定。**MIDI に LinkAudio 型の排他は適用しない**(SC オーディオと併走可)。
- `docs/archive/DSL_SPECIFICATION_v1.0_MIDI.md`: 初期 MIDI 設計。`^`/`~` 修飾と度数0=休符は継承、クロマチック度数と丸括弧和音 `(1,5,8)` は**継承しない**(丸括弧は v3.0 で時間分割に割当済み)。
- タイミング計算は `TimingCalculator`(再帰、`TimedEvent { sliceNumber, startTime, duration, depth }`)。ピッチ DSL では型拡張が必要(spec §7-0 厳守)。
- 既存テスト 230 passed / 23 skipped。audio の play() 意味論は一切変更しない。

## 3. Architecture Decisions

- **EventRouter フル分離はやらない**。`packages/engine/src/midi/` に `MidiOutput` + `MidiScheduler` を新設し AudioEngine と並置。ディスパッチは Sequence 側フラグ。抽象の切り出しは出力先が2例安定してから(v2.0)。
- **MIDI ライブラリ = `@julusian/midi`**(MIT、RtMidi/CoreMIDI、Node 22 prebuilds、`midi` API 互換)。即時送信のみ → TS 側 lookahead スケジューラ(50–100ms、ドリフト補正)。`global.midiLatency()` に加え、**ポート単位の負方向オフセット(先行送出)**を実装(Disklavier 機構レイテンシ校正用。WCTM §9)。
- **Bridge = MCP サーバー**(WCTM §3)。`/mnt/skills` の mcp-builder スキル類を参照可能なら活用。TypeScript、エンジンと同居可。OSC 受信 + エンジン評価口 + ログ末尾。

## 4. Implementation Phases

### Phase 0: 事前検証(コードを書く前に。すべて main agent)

1.  **`(1)(2)` タプル並置の現行挙動**をテストで確定(spec §3.3 の前提)。
2.  **`quantize("bar")` の `play()` 差し替え挙動**を実機検証(仕様通りか未確認とユーザー認識。MIDI note-off と WCTM の小節整列の前提)。
3.  **`@julusian/midi` 素振り**: IAC 列挙・送出、Node 22 + macOS prebuild。
4.  **Link 追従スケジューリングの現状確認**: エンジンの Link 統合がスケジューリングまで beat/phase に従うか、LinkAudio のオーディオ受け渡しのみか。後者なら「Link 追従スケジューリング」を Phase 1 の実装項目に昇格(WCTM §2 の前提)。

### Phase R: `*n` 反復 + パターン変数(spec §6.5。Phase 0 直後、Phase 1 と並行可)

MIDI 非依存の純パーサー/評価器機能。audio に即効。`x*n` = 並置への書き換え(裸イベントは単元グループ化)、`*0` エラー、後置演算子は左→右。パターン変数 = 裸タプル var 束縛、評価時値渡し。Tidal の `*`(スロット内分割)との意味差をドキュメント明記。WCTM ではスキルの語彙制約装置として効く。

### Phase 1: Raw MIDI 出力 + L1 ログ(本番経路の核)

- `seq.midi(port, ch)` / `gate` / `vel` / `octave` / `global.key()` / `midiLatency`(ポート単位オフセット込み)。
- root スコープの度数解決(spec §2.1)。`seq.root()` のみ(チェーンは Phase 2)。
- **TimedEvent 型拡張は spec §7-0 厳守**: シンボリックピッチをパイプライン全体で保持、MIDI 番号化は出力アダプタ最終段のみ。譜面エピックの前提であり、Phase 1 のデータ構造で守らないと取り返せない。
- **Active note tracking + パニック(CC123/CC120)を必ず本フェーズで**。Disklavier では舞台事故防止(WCTM §8)。受け入れ基準: LOOP 差し替え100回で hanging note ゼロ。
- audio シーケンス内の `[ ]` は diagnostic エラーとして予約(spec §10-5)。
- **L1 同乗**: 評価経路傍受(一箇所)、`global.start()` でファイル生成+プリアンブル、三重スタンプ(wall/transport/effect ※effect は Phase 0-2 の検証結果に依存)、`<basename>.<timestamp>.orbslog`、`evalSource`、行単位フラッシュ(異常終了耐性)。

### Phase 2: `.root()` グループチェーン(パーサー作業の中心)

- グループ閉じ後のメソッドチェーン。レキシカルスコープ(内→外→seq 既定)、同一グループ重複は diagnostic エラー、並置全体への適用、「チェーンは並置を閉じる」(チェーン直後のカンマなし `(` はパースエラー)。
- 音名トークン(`F#`, `Bb`)の字句解析(`.root()` 引数位置の文脈依存トークンが安全)。`#` とコメントの衝突確認。
- VS Code 拡張: root スコープのセマンティックハイライト(両忘れ併合の緩和。必須に近い優先度)。

### Phase 3: スタック `[ ]` + chord 値(WCTM の和声コンピングに必須)

- `[ ]` 同時発音、スタック要素の独立サブツリー(TimingCalculator 並列再帰)。
- `chord([...])`、spread、`-` 除去(字面一致)、`^+1` スタック修飾、`import chords`(TS 事前定義テーブル)。

### Phase W: WCTM(WCTM_SYSTEM_SPEC 正本。Phase 1 完了後に着手可)

- **W-Bridge**: MCP サーバー(3ツール: get_performance_features / evaluate_orbitscore / get_session_tail)。OSC 受信、小節整列集約、検証(パース+許可リスト+自己修復1回)、evalSource:“agent”。
- **W-Runtime**: pi(@mariozechner/pi-coding-agent)ベースの専用ハーネス。自前イベントループ(小節到着 → コンテキスト組立 → Messages API 1ターン発火)で MCP Bridge を consume、スキル読み込み、自己修復1回。まず極薄スケルトンを早期起動しチェーンを de-risk(WCTM_SYSTEM_SPEC §4 改訂・決定 \#60–#63)。Claude Code は本番ランタイムではなく開発ツール。
- **W-Link**: Link 追従スケジューリング(Phase 0-4 の結果次第)+ 結合度パラメータ(追従速度係数+信頼度ゲート)。
- **W-Ops**: ゲート/パニック/結合度の操作系(専用アプリは作らない。Max UI + CLI)。
- Max パッチ(入力/出力)とスキル(ATTYA .orbs + 指示書)は人間主導の並行トラック。Claude Code は Max の \[js\]/node4max コード支援に留める。

### Phase 4(余力時)/ L2・Phase 5(本番後)

`_` タイ・`_n` 声部タイ・`{ }`・`.hold()`(ピアノ的価値は高いが本番から落とせる)。L2 リプレイヤー、mode は本番後。

## 5. Delegation Profile for Opus 4.8(subagent / モデル委譲の根拠)

判断基準は**爆発半径**と**仕様の閉性**: 影響が中枢(レキサー/パーサー/スケジューラ)に及ぶものは main agent(Opus)が直列で持つ。仕様書のセクションが完全な契約になっている純関数・隔離モジュールは Sonnet subagent に並列委譲してよい。

| タスク | 担当 | 根拠 |
|----|----|----|
| Phase 0 全項目 | main (Opus) | 検証結果が後続仕様を変えうる。判断を伴う |
| レキサー/パーサー変更(R/2/3 の構文) | main (Opus)、直列 | 爆発半径最大。既存230テストのグリーンが各ゲート |
| 度数解決の数理(spec §2.1/§2.2)+ プロパティテスト | Sonnet subagent、並列可 | 純関数。仕様の数式が完全な契約 |
| `*n` 書き換え・spread・`-` 除去の評価器(構文確定後) | Sonnet subagent | 書き換え規則として閉じている |
| MidiOutput / MidiScheduler | Sonnet subagent | 隔離モジュール。モック MIDI でテスト可能 |
| L1 ログライター | Sonnet subagent(傍受点定義は main) | 形式は SESSION_LOG_SPEC で閉じている |
| W-Bridge (MCP) | Sonnet subagent(ツール契約は spec に閉じている)。mcp-builder スキル参照 | 隔離プロセス |
| W-Runtime (pi ハーネス: 自前ループ + プロンプト) | main (Opus) | プロンプト設計とループ意味論は品質判断を伴う |
| VS Code ハイライト | Sonnet subagent | 拡張側に閉じる |
| Max パッチ | 人間(大和/オペレーター)。Claude は \[js\] コード支援のみ | .maxpat の生成信頼性が低い |

**運用規則**: (1) フェーズゲート = 既存全テスト + 当該フェーズ受け入れ基準。ゲート前に依存フェーズへ進まない。(2) subagent への入力は該当 spec セクション(契約)+ 対象ファイルに限定し、決定済み事項の再設計を試みた場合は §7 の表を提示して却下する。(3) パーサーへの変更は必ず main が行い、subagent はパース済み AST 以降のみを扱う。

## 6. GitHub Issues to Create(着手時に起票)

1.  **`[ ]` stack for audio sequences**(将来開放。構文は diagnostic エラーで予約済み。#2 と相互参照)。
2.  **`slice()` — transient-based audio slicing**(chop の等分に対するオンセット分割。記録のみ)。
3.  **Real-time score rendering / human performer driving**(別エピック、ICLC 2027 候補): ネイティブ経路一本(WebSocket + Verovio/VexFlow。Max/MaxScore 経由は棄却済み——MIDI で情報喪失)。奏者一人=Webページ一つ(譜面+視覚メトロノーム)。M5StickS3 は触覚段階の拡張。構造的優位: §7-0 のスペリング保存 + リズム木と記譜構造の同型性(転写問題が存在しない)。quantize=視奏ルックアヘッド。先行研究: INScore / SmartVox / Decibel ScorePlayer / Quintet.net・MaxScore (Hajdu, HfMT Hamburg)。
4.  **L2 Replayer CLI**(本番後): `orbitscore replay`、`--until` / `--render` / `--verify`。
5.  **WCTM 本番後の分析**: .orbslog から evalSource 比率・タイミングの事後分析(論文素材)。

## 7. Known Decisions(確定済み。再議論しない)

| 決定 | 棄却した代替案 |
|----|----|
| ハーモニーはリズム木内のレキシカルスコープ | グローバル進行レーン(共有グリッド再導入) |
| 基底意味論 = root(Ionian 基準 + b/#)。クオリティは表記が持つ | scale-index 基底 |
| mode = ユーザー定義ピッチ格子(オプトイン) | 教会旋法プリミティブ |
| chord = ルート未束縛の値、spread + `-`(字面一致) | ビルダー API / 解決後ピッチ照合 |
| 声部タイ `_n` はピッチ照合+発音フォールバック。`.hold()` はスタック間限定 | 声部位置対応 / 単音連打適用 |
| root 共有 = タプル並置(改行可)+「チェーンは並置を閉じる」。重複指定はエラー | 外側括弧 / last-wins |
| 無指定区間は seq 既定(stateless)。key 未宣言の数値 root はエラー | 直前維持 / C 基準 |
| `*n` = 並置書き換え(スロット占有)。パターン変数 = 評価時値渡し | Tidal 型 `*` / リアクティブ束縛 |
| audio の `[ ]` は diagnostic エラーで予約 | 即時開放 / 黙って無視 |
| TimedEvent はシンボリックピッチ保持、番号化は出力最終段のみ | 解決済み番号の伝搬 |
| MIDI と SC オーディオは併走可 | LinkAudio 型排他 |
| 記録 = 因果(評価ログ)。キーストローク/画面は「録音」でスコープ外 | 三層フル記録 |
| 再現性 = 因果的同一性(ランダムは再度引く) | 値の記録 |
| フライトレコーダー: `global.start()` 起点+プリアンブル。`.orbs` 並置・basename 継承 | 明示 record() / 集約ディレクトリ |
| リプレイは音楽時間駆動(三重スタンプ)。分岐 = エンジン状態 | 壁時計駆動 / エディタ復元 |
| WCTM: クロックはドラマー起点 + Link + 結合度パラメータ | エンジンマスター / PLL 自作 |
| Bridge = 脳なし MCP。本番ランタイム = pi ベース専用ハーネス(2026-06-28 確定、#60–#63)。評価経路統一 + evalSource | Bridge にループ固定 / LLM 専用経路 |
| 初期スキル = スタンダードのリードシート .orbs + 指示書。WCTM は最小実装(§ WCTM-7) | 専用曲事前設計 / フルスタック構築 |
| EventRouter フル分離は v1.1 でやらない | ROADMAP Stage 1 |

## 8. Documentation Tasks(差分吸収と反映)

**配置**: 本仕様群(`PITCH_DSL_SPEC` / `SESSION_LOG_SPEC` / `WCTM_SYSTEM_SPEC` / 本書 / `DESIGN_DISCUSSION_RECORD`)は **`docs/specs-v2/`** に置く。HTML 版が正(アーキテクチャ図を含むため。議論記録のみ md 併存)。

### 8.1 差分吸収(既存ドキュメントの整合)

1.  `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` が single source of truth(自己宣言)。`docs/specs-v2/` への参照リンクを core spec に追加し、**各フェーズのゲート時に当該機能のセクションを core spec へ反映する**(specs-v2 と core spec の乖離を作らない)。
2.  `docs/user/en|ja/USER_MANUAL.md` は stale(2025-10-26。audioPath 複数/quantize/LinkAudio 未反映)。**廃止方向**: deprecation notice + VitePress への誘導。core spec → VitePress reference の一方向生成に一本化。
3.  LinkAudio の DSL 構文(`init global.linkAudio()`, `seq.output()`)は research doc にのみ存在。core spec に統合。
4.  v1.0 アーカイブ冒頭に「v1.1 で MIDI 対応が別設計で実現」+ `docs/specs-v2/` への参照を追記(系譜資料)。

### 8.2 ラーニングサイト(VitePress)への反映 — 特にピッチ DSL

ユーザー向け学習サイト(signalcompose.github.io/orbitscore)に v1.1 の新機能を反映する。これは仕様の転記ではなく**チュートリアルとしての書き直し**(既存 T1–T8 のトーンに合わせる)。

- 新チャプター案: 「MIDI 出力のセットアップ(IAC/ソフトシンセ)」「はじめての note(度数と root)」「コードとスタック(chord 値・spread)」「タイ・レガート・hold」「反復とパターン変数(audio にも使える)」。リファレンスページに新メソッド群を追加。
- **Tidal の `*` との意味差**(spec §6.5.1 の注記)はユーザー文書側に必ず明記。
- 日英両言語。既存の翻訳ワークフロー(`docs/development/TRANSLATION_WORKFLOW.md`, `docs/development/translation-prompts/`)に従う。
- **タイミング**: Phase 3 ゲート後に着手可、ただし WCTM クリティカルパス外なので Sonnet subagent への委譲対象(spec セクション+既存チュートリアルのトーンが契約)。本番前に間に合わなければ本番後最優先。8.1-1 の core spec 反映だけは各フェーズゲートで必ず行う(こちらは乖離が実害になるため)。

## 9. Testing Strategy

- **純関数網羅**: 度数解決(受理度数 `{1-9,11,13}` × b/# × pitch range `^N`(スティッキー)、不正度数 `{10,12,14,15+}` のエラー、mode 格子、root 音名/数値/key 未宣言エラー)、`*n` 等価性(`(1,0)*2` ≡ `(1,0)(1,0)` のタイミング列)、spread/`-`。
- **パーサー**: 新トークン群、スコープ解決(内外・並置・重複エラー・チェーン後カンマなしエラー)、audio 構文の回帰(230 テスト維持)。
- **MIDI**: モック出力で note-on/off 完全性、tie 抑制、legato 順序。**hanging note 不変条件**(note-on 数 = note-off 数)を LOOP 差し替え/MUTE/quantize 待機中差し替え/stop の全経路でプロパティテスト。
- **L1**: 記録→(将来 L2 で)リプレイのラウンドトリップを見据え、まずプリアンブル完全性・三重スタンプ整合・複数ファイル sourceFile・異常終了(kill -9)での行単位耐性。
- **WCTM**: Bridge ツールの契約テスト(不正コード→diagnostic、許可リスト)、E2E は手動チェックリスト(`docs/testing/` に WCTM_E2E_CHECKLIST を新設: ソフトピアノ代替系統→Disklavier 校正手順)。
