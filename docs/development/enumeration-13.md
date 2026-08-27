## 列挙コマンド13本の実行結果（完了条件 §1-12）

実行日時: 2026-08-28 05:57 / コミット: 4a08ecd6

| # | 何の列挙 | コマンド | 件数 |
|---|---|---|---|
| 1 | OutProcControl 構築箇所 | `grep -n 'OutProcControl {' rust/crates/orbit-audio-daemon/src/*.rs` | **10** |
| 2 | 旧 effect child への参照 | `grep -rn 'clap-effect-child\|vst3-effect-child' rust/ packages/ tests/ docs/ .github/ --exclude-dir=target` | **150** |
| 3 | --plugin CLI の組み立て | `grep -rn '"--plugin"' rust/crates/ --exclude-dir=target` | **21** |
| 4 | mailbox CMD_ 定数の消費側 | `grep -rn 'CMD_APPLY_CHAIN\|CMD_SAVE_STATE_AT\|CMD_OPEN_UI_AT\|CMD_CLOSE_UI_AT' rust/ --exclude-dir=target` | **31** |
| 5 | wire メソッド名 | `grep -rn 'ApplyEffectChain\|UnloadPlugin\|ReplacePlugin' packages/engine/src rust/crates/orbit-audio-daemon/src docs/research/ENGINE_DAEMON_PROTOCOL.md` | **87** |
| 6 | DSL 語彙の remove | `grep -n 'remove' packages/engine/src/signal-chain/runtime.ts` | **0** |
| 7 | chain_path の透過 | `grep -rn 'chain_path' rust/crates/orbit-audio-daemon/src packages/engine/src` | **24** |
| 8 | state manifest の直接読み書き | `grep -rn 'manifest.states' packages/engine/src` | **6** |
| 9 | EffectSlotLimitError の消費 | `grep -rn 'EffectSlotLimitError' packages/ tests/ --exclude-dir=node_modules` | **11** |
| 10 | メソッド形解決の残骸 | `grep -rn 'resolveCatalogMethodCandidates\|catalogEntriesForMethod' packages/engine/src packages/vscode-extension/src` | **1** |
| 11 | ui( の数値 index 形 | `grep -rnE '\.ui\(\s*[0-9]' packages/engine/src tests/ docs/core/INSTRUCTION_ORBITSCORE_DSL.md` | **6** |
| 12 | 標準プラグインの参照 | `grep -rn 'std-plugins\|orbit-std-gain\|ORBIT_STD_PLUGIN_DIR' rust/ packages/ tests/ scripts/ .github/ --exclude-dir=target` | **37** |
| 13 | 旧補完 regex | `grep -n 'PLUGIN_ARG_RE' packages/vscode-extension/src/*.ts` | **0** |
