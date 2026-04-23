# scsynth Bundle Manifest

**日付**: 2026-04-23
**Last verified**: 2026-04-23 (SC 3.14.1)
**対象 Issue**: #134
**関連 Epic**: #131 (v1.0 ICMC Ready Phase 1)
**前提**: [SCSYNTH_STANDALONE.md](./SCSYNTH_STANDALONE.md) で SC.app 外 standalone 起動検証済
**SC バージョン**: SuperCollider 3.14.1 (Homebrew cask、universal binary)
**再検証トリガー**: SC の Major/Minor bump 時 (section "Update policy" 参照)

---

## 目的

`.vsix` に同梱する最小セット (plugin / dylib) と配置構造を primary-source で確定する。下流 issue (#136 bundle 実装、#139 LICENSE 整備) の前提ドキュメント。

---

## 決定サマリ

| 項目 | 決定 | 理由 |
|---|---|---|
| Plugin 範囲 | **全 non-supernova 26 ファイル** (5.1 MB) | GPL-3.0 aggregation 性を強く保つ。選別 = "改変" 疑義。Sonic Pi 先例も全 plugin 同梱 |
| Architecture | **universal (arm64 + x86_64) のまま** | SC 公式 binary が既に universal。分離する利点なし |
| dylib 範囲 | **libsndfile.dylib のみ** (4.9 MB) | scsynth の唯一の外部依存。`libfftw3f` は **いずれの scx/scsynth も依存していないことを otool で確認** → **同梱しない** |
| Bundle 配置 | `packages/vscode-extension/engine/scsynth/Contents/{Resources,Frameworks}/` | scsynth の `@loader_path/../Frameworks/libsndfile.dylib` を壊さないため SC.app 同構造を保持 |
| 抽出元 | **Homebrew cask `supercollider`** (推奨) / SC.app 公式 dmg (fallback) | CI 自動化しやすい。個人マシンでも再現性高い |
| Update policy | Major/Minor bump のみ re-extract、Patch は据え置き | 実音 regression 通過版を昇格 |

**合計 bundle サイズ見込: ~11.5 MB** (scsynth 1.5 MB + plugins 5.1 MB + libsndfile.dylib 4.9 MB)

当初 plan の ~13 MB から **libfftw3f 不要確定で 1.6 MB 削減**。

---

## SynthDef → UGen 対応

`packages/engine/supercollider/setup.scd` に定義されている 4 SynthDef の使用 UGen:

| SynthDef | 使用 UGen |
|---|---|
| `orbitPlayBuf` | `PlayBuf.ar`, `BufDur.kr`, `BufRateScale.kr`, `BufSampleRate.kr`, `Select.kr`, `EnvGen.kr`, `Env.linen`, `Pan2.ar`, `Out.ar` |
| `fxCompressor` | `In.ar`, `Compander.ar`, `ReplaceOut.ar` |
| `fxLimiter` | `In.ar`, `Limiter.ar`, `ReplaceOut.ar` |
| `fxNormalizer` | `In.ar`, `Normalizer.ar`, `ReplaceOut.ar` |

推定収録 plugin: `BufIO_UGens.scx` / `TriggerUGens.scx` (Select) / `LFUGens.scx` (EnvGen) / `IOUGens.scx` (In/Out/ReplaceOut) / `PanUGens.scx` (Pan2) / `FilterUGens.scx` (Compander/Limiter/Normalizer)。

ただし個別 UGen が厳密にどの scx に収まるかは SC version で変動するため **個別選別は行わない**。#133 の E2E 検証 (orbitPlayBuf load + WAV 再生 /n_go→/n_end 成功) により、non-supernova 26 ファイル同梱で必要 UGen を全カバーすることを実証済。

---

## Non-supernova plugin 一覧 (26 ファイル、5.1 MB)

実測 (2026-04-23, SC 3.14.1):

| # | ファイル | サイズ (bytes) | 想定収録 UGen |
|---|---|---:|---|
| 1 | BinaryOpUGens.scx | 563,824 | `+`, `-`, `*`, `/` 等の二項演算 |
| 2 | ChaosUGens.scx | 167,760 | カオス系 noise |
| 3 | DelayUGens.scx | 422,432 | `DelayN`, `DelayL`, `CombC` 等 |
| 4 | DemandUGens.scx | 201,248 | `Demand`, `Duty` 等 |
| 5 | DemoUGens.scx | 134,080 | サンプル UGen |
| 6 | DiskIO_UGens.scx | 154,400 | `DiskIn`, `DiskOut` |
| 7 | DynNoiseUGens.scx | 84,656 | 動的 noise |
| 8 | FFT_UGens.scx | 203,904 | `FFT`, `IFFT` (Accelerate.framework 経由、**libfftw3f 非依存**) |
| 9 | FilterUGens.scx | 302,912 | `Compander`, `Limiter`, `Normalizer` 等 |
| 10 | GendynUGens.scx | 134,048 | `Gendy1` 等 |
| 11 | GrainUGens.scx | 233,664 | `GrainBuf`, `GrainSin` 等 |
| 12 | IOUGens.scx | 168,672 | `In`, `Out`, `ReplaceOut` 等 |
| 13 | LFUGens.scx | 237,776 | `SinOsc`, `LFSaw`, `EnvGen` 等 |
| 14 | ML_UGens.scx | 251,888 | `MFCC`, `Onsets` 等 |
| 15 | MulAddUGens.scx | 243,584 | `MulAdd` |
| 16 | NoiseUGens.scx | 168,544 | `WhiteNoise`, `PinkNoise` 等 |
| 17 | OscUGens.scx | 219,392 | `Osc`, `COsc` 等 |
| 18 | PanUGens.scx | 168,112 | `Pan2`, `Pan4`, `PanAz` 等 |
| 19 | PhysicalModelingUGens.scx | 84,416 | `Spring` 等 |
| 20 | PV_ThirdParty.scx | 169,056 | Spectral 系 |
| 21 | ReverbUGens.scx | 150,608 | `FreeVerb`, `GVerb` 等 |
| 22 | TestUGens.scx | 100,960 | `CheckBadValues` 等 |
| 23 | TriggerUGens.scx | 187,904 | `Trig`, `Select`, `Latch` 等 |
| 24 | UIUGens.scx | 136,464 | Keyboard/Mouse UGens |
| 25 | UnaryOpUGens.scx | 256,272 | `abs`, `neg`, `sin` 等 |
| 26 | UnpackFFTUGens.scx | 134,144 | Spectral 系 |

全ファイルは **Mach-O universal binary (arm64 + x86_64)**。

`_supernova.scx` suffix の 26 ファイル (multi-core scsynth 代替 "supernova" server 向け) は**同梱しない**。OrbitScore は `scsynth` のみを使用。

---

## dylib 依存グラフ (otool 実測)

### scsynth の依存

```
/Applications/SuperCollider.app/Contents/Resources/scsynth:
  /usr/lib/libSystem.B.dylib                    ← macOS 標準
  @loader_path/../Frameworks/libsndfile.dylib   ← ★同梱対象
  /System/Library/Frameworks/CoreAudio          ← macOS 標準
  /System/Library/Frameworks/Accelerate         ← macOS 標準
  /System/Library/Frameworks/CoreServices       ← macOS 標準
  /System/Library/Frameworks/Foundation         ← macOS 標準
  /System/Library/Frameworks/AppKit             ← macOS 標準
  /usr/lib/libobjc.A.dylib                      ← macOS 標準
  /usr/lib/libc++.1.dylib                       ← macOS 標準
  /System/Library/Frameworks/CFNetwork          ← macOS 標準
  /System/Library/Frameworks/CoreFoundation     ← macOS 標準
```

### Plugin 側の dylib 依存

全 26 plugin を `otool -L | grep libfftw` で検索 → **いずれも libfftw3f を参照せず**。FFT_UGens.scx も `Accelerate.framework` の vDSP のみ使用。

FFT_UGens.scx の依存 (代表):
```
/Applications/SuperCollider.app/Contents/Resources/plugins/FFT_UGens.scx:
  /usr/lib/libSystem.B.dylib
  /System/Library/Frameworks/Accelerate           ← FFT は Accelerate 経由
  /usr/lib/libc++.1.dylib
```

→ **libfftw3f.dylib は bundle 不要**。元 plan の「同梱推奨」は撤回。

### 省く dylib

- **libfftw3f.dylib**: 上記の通り誰も参照しない。macOS SC 3.14.1 は Accelerate を採用
- **libreadline.dylib**: sclang (SC 言語コンパイラ) 専用で scsynth 非依存
- **Qt frameworks**: SCIDE 専用、504 MB 相当を丸ごと省略

---

## Bundle 最終 manifest

```
packages/vscode-extension/engine/scsynth/
├── Contents/
│   ├── Resources/
│   │   ├── scsynth                         (1.5 MB, universal)
│   │   └── plugins/
│   │       ├── BinaryOpUGens.scx           (以下 26 ファイル計 5.1 MB)
│   │       ├── ChaosUGens.scx
│   │       ├── DelayUGens.scx
│   │       ├── DemandUGens.scx
│   │       ├── DemoUGens.scx
│   │       ├── DiskIO_UGens.scx
│   │       ├── DynNoiseUGens.scx
│   │       ├── FFT_UGens.scx
│   │       ├── FilterUGens.scx
│   │       ├── GendynUGens.scx
│   │       ├── GrainUGens.scx
│   │       ├── IOUGens.scx
│   │       ├── LFUGens.scx
│   │       ├── ML_UGens.scx
│   │       ├── MulAddUGens.scx
│   │       ├── NoiseUGens.scx
│   │       ├── OscUGens.scx
│   │       ├── PanUGens.scx
│   │       ├── PhysicalModelingUGens.scx
│   │       ├── PV_ThirdParty.scx
│   │       ├── ReverbUGens.scx
│   │       ├── TestUGens.scx
│   │       ├── TriggerUGens.scx
│   │       ├── UIUGens.scx
│   │       ├── UnaryOpUGens.scx
│   │       └── UnpackFFTUGens.scx
│   └── Frameworks/
│       └── libsndfile.dylib                (4.9 MB, universal)
├── LICENSE.GPL-3.0                          (#139 で整備)
└── NOTICE                                   (#139 で整備、GPL 準拠 source URL 記載)
```

---

## 抽出手順 (再現可能)

### 推奨: Homebrew cask 経由

```bash
#!/usr/bin/env bash
set -euo pipefail

SC_ROOT="/Applications/SuperCollider.app/Contents"
DEST="packages/vscode-extension/engine/scsynth/Contents"

# 1. SC install 確認 (fail-fast; 未導入なら Homebrew で install 試行)
if ! [ -d /Applications/SuperCollider.app ]; then
  echo "SuperCollider.app not found. Attempting Homebrew install..." >&2
  brew install --cask supercollider
fi
if ! [ -f "$SC_ROOT/Resources/scsynth" ]; then
  echo "ERROR: scsynth binary not found at expected path" >&2
  echo "  Expected: $SC_ROOT/Resources/scsynth" >&2
  exit 1
fi
if ! [ -f "$SC_ROOT/Frameworks/libsndfile.dylib" ]; then
  echo "ERROR: libsndfile.dylib not found" >&2
  exit 1
fi

# 2. ディレクトリ作成
mkdir -p "$DEST/Resources/plugins" "$DEST/Frameworks"

# 3. scsynth 本体
cp "$SC_ROOT/Resources/scsynth" "$DEST/Resources/scsynth"

# 4. plugins (non-supernova のみ)
plugin_count=0
for f in "$SC_ROOT/Resources/plugins/"*.scx; do
  basename=$(basename "$f")
  if [[ "$basename" != *_supernova.scx ]]; then
    cp "$f" "$DEST/Resources/plugins/$basename"
    plugin_count=$((plugin_count + 1))
  fi
done
if [ "$plugin_count" -ne 26 ]; then
  echo "ERROR: expected 26 non-supernova plugins, got $plugin_count" >&2
  echo "  SC version may have added/removed plugins; update manifest doc." >&2
  exit 1
fi

# 5. dylib (libsndfile のみ)
cp "$SC_ROOT/Frameworks/libsndfile.dylib" "$DEST/Frameworks/libsndfile.dylib"

# 6. 検証
echo "Bundle size:"
du -sh "$DEST"

echo "Architecture check (should show universal):"
file "$DEST/Resources/scsynth" | grep -E "universal|arm64.*x86_64" || {
  echo "ERROR: scsynth is not universal binary" >&2
  exit 1
}

echo "Signature check (should be SC official, team HE5VJFE9E4):"
codesign --verify --verbose "$DEST/Resources/scsynth" 2>&1 | tail -3
codesign -dv "$DEST/Resources/scsynth" 2>&1 | grep TeamIdentifier | grep -q HE5VJFE9E4 || {
  echo "ERROR: scsynth signature TeamIdentifier is not HE5VJFE9E4" >&2
  exit 1
}
echo "OK: bundle prepared at $DEST"
```

### Fallback: SC.app discovery

Homebrew 未導入 / 別 path にある場合:

```bash
SC_APP=$(
  # Homebrew cask default
  [ -d /Applications/SuperCollider.app ] && echo /Applications/SuperCollider.app ||
  # 旧 installer layout (念のため)
  [ -d /Applications/SuperCollider/SuperCollider.app ] && echo /Applications/SuperCollider/SuperCollider.app ||
  # Spotlight 検索 (最終手段)
  mdfind -name SuperCollider.app | head -1
)
```

---

## Update policy

| SC バージョン変動 | 対応 |
|---|---|
| Major (3 → 4) | Breaking 想定、full re-extract + 実音 regression 全通過まで保留 |
| Minor (3.14 → 3.15) | re-extract、実音 regression 後に `.vsix` 昇格 |
| Patch (3.14.1 → 3.14.2) | **即時追従しない**。security fix 等 critical でなければ据え置き |

SC 公式 release notes と `codesign -dv` Timestamp を定期 watch (~ quarterly)。

---

## Cold-install verification checklist (#138 向け)

`.vsix` install 後の新規 Mac で以下を満たすこと:

- [ ] `scsynth` バイナリが `Contents/Resources/scsynth` に存在
- [ ] `plugins/` 配下に **26 ファイル** (non-supernova のみ) 存在、supernova variant は含まない
- [ ] `libsndfile.dylib` が `Contents/Frameworks/` に存在
- [ ] `scsynth` が実行権限付き (`-rwxr-xr-x` 等)
- [ ] `file` 出力が universal binary (arm64 + x86_64)
- [ ] `codesign --verify --verbose` が exit 0 で "valid on disk" + "satisfies its Designated Requirement" を stdout に含む
- [ ] `codesign -dv` の TeamIdentifier が `HE5VJFE9E4`
- [ ] scsynth が standalone 起動 (`-u <port> -i 0`) 成功、`SuperCollider 3 server ready.` ログ出力
- [ ] OSC `/status` で `/status.reply` 受信
- [ ] `orbitPlayBuf.scsyndef` の `/d_recv` で `/done` 受信
- [ ] WAV `/b_allocRead` + `/s_new` で `/n_go` + `/n_end` 受信

検証 script (再利用可): [`docs/research/scripts/verify-bundle.sh`](./scripts/verify-bundle.sh) として #136 実装時に整備。

### 失敗時の診断フロー

| 失敗箇所 | 典型原因 | 対応 |
|---|---|---|
| 項目 1-4 (ファイル配置) | 抽出 script の path 決定不良 / SC.app location 差異 | extract script 再実行、path 候補 fallback を追加 |
| 項目 5-7 (codesign / TeamIdentifier) | vsce packaging で LC_CODE_SIGNATURE 破損 / xattr 不正 stripping | 元 SC.app からの再抽出、vsce version 確認 |
| 項目 8 (scsynth 起動失敗) | ポート衝突 (default 57110)、権限不足、Gatekeeper 拒否 | `lsof -i :57110` で占有確認 → 別ポートで再試行、`xattr -l` で quarantine 確認 |
| 項目 9-11 (OSC round-trip 失敗) | scsynth が boot 途中で crash / ファイアウォール | scsynth stderr をキャプチャ、boot 完了を 10 秒 timeout で待機、失敗したら `scsynth -v` で verbose log 取得 |

タイムアウト目安 (#138 CI 向け):
- scsynth boot: **10 秒** (`SuperCollider 3 server ready.` 表示まで)
- OSC `/status` round-trip: **2 秒**
- `/d_recv` + `/b_allocRead` + `/s_new` → `/n_end`: **5 秒**

## #136 実装時の注意点

1. **ディレクトリ構造保持**: `Contents/Resources/` + `Contents/Frameworks/` を崩すと scsynth の `@loader_path/../Frameworks/libsndfile.dylib` が解決失敗
2. **Universal binary のまま同梱**: `lipo -info <binary>` で arm64+x86_64 両方含まれること確認
3. **permission**: `chmod +x` で scsynth 実行権限が `.vsix` 展開後も残ること (zip は実行権限を保持する)
4. **path resolution (`osc-client.ts`)**: hardcode されている `/Applications/SuperCollider.app/...` を bundle 相対 path に差し替え、fallback として SC.app 検出ロジックを残す
5. **GPL NOTICE**: `LICENSE.GPL-3.0` と `NOTICE` は #139 で整備するが、bundle の隣に配置することは本 manifest の前提

---

## 関連ドキュメント

- [SCSYNTH_STANDALONE.md](./SCSYNTH_STANDALONE.md) — standalone 起動検証 (#133)
- [CODESIGN_PIPELINE.md](./CODESIGN_PIPELINE.md) — 署名戦略 (#135)
- [ENGINE_DAEMON_PROTOCOL.md](./ENGINE_DAEMON_PROTOCOL.md) — OSC protocol spec
- `packages/engine/supercollider/setup.scd` — SynthDef 定義 (UGen inventory source)
- [SuperCollider 3.14.1 Release](https://github.com/supercollider/supercollider/releases/tag/Version-3.14.1) — corresponding source (GPL-3.0 §6)
