# 列挙コマンド13本の実行結果（完了条件 §1-12）

**実行日時**: 2026-08-28 22:0x / **コミット**: `b052732f` + 本コミット（最終）

> PR #629 で**列挙漏れが 3 回**出た（うち 1 回はレビュー 5 体を通過し CI だけが検出）。
> その対策として設計 §7 が定めた 13 本。**レビューは件数の照合から始める。**

| # | 何の列挙 | コマンド | 件数 |
|---|---|---|---|
| 1 | `OutProcControl` 構築箇所 | `grep -n 'OutProcControl {' rust/crates/orbit-audio-daemon/src/*.rs` | **10** |
| 2 | 旧 effect child への参照 | `grep -rn 'clap-effect-child\|vst3-effect-child' rust/ packages/ tests/ docs/ .github/` | **153** |
| 3 | `--plugin` CLI の組み立て | `grep -rn '"--plugin"' rust/crates/` | **21** |
| 4 | mailbox `CMD_` 定数の消費側 | `grep -rn 'CMD_APPLY_CHAIN\|CMD_SAVE_STATE_AT\|CMD_OPEN_UI_AT\|CMD_CLOSE_UI_AT' rust/` | **33** |
| 5 | wire メソッド名 | `grep -rn 'ApplyEffectChain\|UnloadPlugin\|ReplacePlugin' packages/engine/src rust/crates/orbit-audio-daemon/src docs/research/ENGINE_DAEMON_PROTOCOL.md` | **91** |
| 6 | DSL 語彙の `remove` | `grep -n 'remove' packages/engine/src/signal-chain/runtime.ts` | **0** ✅ |
| 7 | `chain_path` の透過 | `grep -rn 'chain_path' rust/crates/orbit-audio-daemon/src packages/engine/src` | **24** |
| 7b | 🔴 `chain_path` が `mcp-server.ts` に在るか（additive 化の証跡・Q4 項目 7） | `grep -c 'chain_path' packages/vscode-extension/src/mcp-server.ts` | **11** ✅ |
| 8 | state manifest の直接読み書き（`project-state-store.ts` 以外） | `grep -rn 'manifest.states' packages/engine/src \| grep -v project-state-store` | **0** ✅ |
| 9 | `EffectSlotLimitError` の消費 | `grep -rn 'EffectSlotLimitError' packages/ tests/` | **11** |
| 10 | メソッド形解決の残骸 | `grep -rn 'resolveCatalogMethodCandidates\|catalogEntriesForMethod' packages/engine/src packages/vscode-extension/src` | **0** ✅（下記） |
| 11 | `ui(` の数値 index 形 | `grep -rnE '\.ui\(\s*[0-9]' packages/engine/src tests/ docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | **2**（下記） |
| 12 | 標準プラグインの参照 | `grep -rn 'std-plugins\|orbit-std-gain\|ORBIT_STD_PLUGIN_DIR' rust/ packages/ tests/` | **30** |
| 13 | 旧補完 regex | `grep -n 'PLUGIN_ARG_RE' packages/vscode-extension/src/*.ts` | **0** ✅ |

---

## 🔴 項目 10 — 列挙が本物の残骸を 1 件見つけた

前回の記録（コミット `4a08ecd6`）では **1** と記録されたまま**未処置**だった。

`resolveCatalogMethodCandidates`（`plugin-resolver.ts`）は**撤回された SC.10.9（メソッド形）
の残骸**で、**source 側に呼び出し元が 1 件も無い**（dist の成果物と自身の export のみ）。
設計 §7 の要求は「診断用の照合（§3.5-(5)）以外に **0 件**」。

**到達不能を実行で証明してから削除した**（grep だけを根拠にしない）:

```
削除後: npm run build 型エラー 0 / npm test 2079 passed / npm run lint 0
```

同じ grep が拾う `resolve.ts:74` の `kind: 'plugin'` は**残す** — あれは
**診断用の名前衝突分類器**（`dsl-method` / `mixer-name` / `plugin` / `unknown` を返す）
そのもので、設計が明示的に認めている用途。

## 項目 11 — 2 件は「残骸」ではなくガード本体

```
tests/core/rack-ui.spec.ts:139       await expect(bus.ui(1 as any)).rejects.toThrow('numeric indexes are not supported')
tests/core/plugin-ui-dsl.spec.ts:54  await expect(sequence.ui(1 as never)).rejects.toThrow('numeric indexes are not supported')
```

いずれも**数値 index が拒否されることを検査する負のテスト**。
「数値 index 形は DSL から消えている」（完了条件 §1-15）という意図は満たされている。
grep が自分のガードを拾っているだけなので、**この 2 件は残す**。

> **注**: この grep を「0 件でなければ不合格」と機械的に運用すると、**ガードを消す方向の
> 圧力になる**。件数だけでなく**中身を読む**こと。
