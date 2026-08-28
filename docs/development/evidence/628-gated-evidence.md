# #628 実機ゲートの実測（完了条件 Q4 項目 5(c)）

**実行**: 2026-08-28 / ブランチ `628-rack-impl` / `npm run test:e2e:gated`
**結果**: 10 tests — 7 passed / 3 failed（**赤 3 件はすべて既知欠陥 `UI_CLOSED_DONE`・#633 送り**）

```
   × OrbitStudio Agent Bridge MCP E2E (gated, real app) > drives real OrbitStudio end-to-end: diagnostics-on-open, run_selection, live edit, capture verification 55833ms
   ✓ OrbitStudio Agent Bridge MCP E2E (gated, real app) > rescans catalog v2 through MCP, reports a broken bundle, and preserves a known CLAP fixture 5ms
   × OrbitStudio Agent Bridge MCP E2E (gated, real app) > reports an ambiguous bare mixer name through run_selection and get_log 15145ms
   ✓ OrbitStudio Agent Bridge MCP E2E (gated, real app) > restores an MCP-saved non-default instrument state across an engine restart with the same measured pitch  26227ms
   ✓ OrbitStudio Agent Bridge MCP E2E (gated, real app) > restores a non-default sum-bus insert across restart through its prefixed receiver identity  24729ms
   ✓ OrbitStudio Agent Bridge MCP E2E (gated, real app) > auto-records and restores all five plugin receiver kinds across a restart without explicit saves  54994ms
   × OrbitStudio Agent Bridge MCP E2E (gated, real app) > replaces a playing instrument across CLAP/VST3 with audio, state, process, failure, and UI oracles (#618 E1-E6) 33824ms
   ✓ OrbitStudio Agent Bridge MCP E2E (gated, real app) > replaces and removes playing effects with audio, state, process, failure, routing, and master oracles (#625 R-E1-R-E7)  33166ms
   ✓ OrbitStudio Agent Bridge MCP E2E (gated, real app) > #628 R28: rack chain audio mainline  42812ms
   ✓ OrbitStudio Agent Bridge MCP E2E (gated, real app) > #628 R28: rack master + MCP standard-element error  534ms
```

## 全区間の RMS（`busDry` 比つき）

```json
{"busDry":0.09956056654792034,"full":0.02514884349818141,"bypassA":0.03514653323525527,"reEnabled":0.025148824849955863,"withoutB":0.039946304300245594,"reAddedB":0.028101474913160972,"withoutGain":0.05021360296631589,"reAddedGain":0.028100785085960985,"gainUnity":0.050178546501864076,"failedApply":0.05019082754736838,"full/dry":0.2525984370134817,"bypassA/dry":0.35301660540811197,"withoutB/dry":0.401226164989918,"withoutGain/dry":0.5043523224844965,"gainUnity/dry":0.5040002105423156,"failedApply/gainUnity":1.000244746935901}
```

設計 §3.1 の期待値との対応:

| 区間 | 期待比 | 実測比 | 意味 |
|---|---|---|---|
| full | 0.2526 | **0.2526** | A × B × Gain(-6dB) の 3 段が全部効いている |
| bypassA | 0.3157 | **0.3530** | A を bypass（許容 15% 内） |
| withoutB | 0.4009 | **0.4012** | B を drop |
| withoutGain | 0.5040 | **0.5044** | Gain を drop |
| gainUnity | 0.5040 | **0.5040** | Gain を 0dB に |

## 窓系列（3 秒 × 22 窓）

```json
{"busDry":"0.000,0.000,0.000,0.233,0.010,0.000,0.000,0.000,0.233,0.011,0.000,0.000,0.000,0.233,0.010,0.000,0.000,0.000,0.233,0.010,0.000,0.000","full":"0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000","bypassA":"0.074,0.005,0.000,0.000,0.000,0.074,0.005,0.000,0.000,0.000,0.074,0.005,0.000,0.000,0.000,0.074,0.005,0.000,0.000,0.000,0.074,0.005","reEnabled":"0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000","withoutB":"0.007,0.000,0.000,0.000,0.093,0.007,0.000,0.000,0.000,0.093,0.007,0.000,0.000,0.000,0.093,0.007,0.000,0.000,0.000,0.093,0.007,0.000","reAddedB":"0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059","withoutGain":"0.009,0.000,0.000,0.000,0.117,0.009,0.000,0.000,0.000,0.117,0.009,0.000,0.000,0.000,0.117,0.009,0.000,0.000,0.000,0.117,0.009,0.000","reAddedGain":"0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059,0.004,0.000,0.000,0.000,0.059","gainUnity":"0.000,0.000,0.000,0.117,0.009,0.000,0.000,0.000,0.117,0.009,0.000,0.000,0.000,0.117,0.009,0.000,0.000,0.000,0.117,0.009,0.000,0.000","failedApply":"0.005,0.000,0.000,0.000,0.118,0.005,0.000,0.000,0.000,0.118,0.005,0.000,0.000,0.000,0.118,0.005,0.000,0.000,0.000,0.118,0.005,0.000"}
```

## onset（3 秒あたり）

```json
{"busDry":4,"full":4,"bypassA":5,"reEnabled":4,"withoutB":4,"reAddedB":4,"withoutGain":4,"reAddedGain":5,"gainUnity":4,"failedApply":4}
```

## 🔴 変異検証（実機・2 件とも red）

**Fable の指摘**: 変異は**ビルド済み配布物に載って初めて効く**。gated は実アプリ（dist）を
駆動するので、`変異 → npm run build → 再起動 → gated → restore → build → 再起動` の順を厳守した。

### (i) keep op の `enabled` 差分を落とす

```
R28 bypassA must be 0.3157479571851815x bus dry (actual=0.25557294688282567): expected 0.1905792545383408 to be less than or equal to 0.15
```

期待 0.3157（A を bypass）に対し実測 0.2556（**A が有効なまま**）。誤差 19.06% > 許容 15%。

### (ii) standard の `params` を落とす

```
R28 full must be 0.2525983657481452x bus dry (actual=0.5039950322325158): expected 0.9952426483036999 to be less than or equal to 0.15
```

期待 0.2526 に対し実測 0.5040 — **ちょうど約 2 倍**。`Gain` が -6dB（線形 0.5011）ではなく
既定の 0dB（線形 1.0）で動いており、`params` が届いていないことを音が示している。誤差 99.52%。

🔴 **どちらも headless では両方 green だった。** 配線の全長
（TS → JSON-RPC → daemon → manifest → child → プラグイン状態 → 音の振幅）
のどこが切れても赤くなる形で、ユニットテストでは原理的に見えない。

### restore 後

```
   ✓ OrbitStudio Agent Bridge MCP E2E (gated, real app) > #628 R28: rack chain audio mainline  42812ms
   ✓ OrbitStudio Agent Bridge MCP E2E (gated, real app) > #628 R28: rack master + MCP standard-element error  534ms
```
