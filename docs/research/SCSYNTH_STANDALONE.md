# scsynth Standalone 動作検証

**日付**: 2026-04-20
**対象 Issue**: #133
**関連 Epic**: #131 (v1.0 ICMC Ready Phase 1)
**SC バージョン**: SuperCollider 3.14.1 (Homebrew cask、universal binary)

---

## 目的

SuperCollider.app 本体を install せず、scsynth バイナリと最小依存のみを同梱して動作するか検証。`.vsix` 単独インストールで scsynth を bundle する戦略 (Sonic Pi パターン) の前提確認。

---

## 検証結果: ✅ 動作する

- scsynth は SC.app 外の任意ディレクトリから起動可能
- OSC 経由の `/status`, `/d_recv`, `/b_allocRead`, `/s_new`, `/n_end` イベント全て正常
- orbitPlayBuf.scsyndef の load + WAV 再生トリガ + synth 終了通知まで確認

---

## 最小依存セット

SC.app (556 MB) から抽出すべきファイル:

```
scsynth-bundle/
├── Contents/
│   ├── Resources/
│   │   ├── scsynth                    1.5 MB  (universal: arm64 + x86_64)
│   │   └── plugins/                   10 MB   (52 files; non-supernova は 5.1 MB)
│   │       ├── BinaryOpUGens.scx
│   │       ├── BufIO_UGens.scx        ← PlayBuf, BufDur, BufRateScale 等
│   │       ├── ChaosUGens.scx
│   │       ├── DelayUGens.scx
│   │       ├── DemandUGens.scx
│   │       ├── DiskIO_UGens.scx
│   │       ├── DynNoiseUGens.scx
│   │       ├── FFT_UGens.scx
│   │       ├── FilterUGens.scx        ← EnvGen, Compander, Limiter, Normalizer
│   │       ├── GendynUGens.scx
│   │       ├── IOUGens.scx            ← Out, In, ReplaceOut
│   │       ├── KeyboardUGens.scx
│   │       ├── LFUGens.scx
│   │       ├── MachineListening.scx
│   │       ├── MouseUGens.scx
│   │       ├── NoiseUGens.scx
│   │       ├── OscUGens.scx
│   │       ├── PanUGens.scx           ← Pan2
│   │       ├── PhysicalModelingUGens.scx
│   │       ├── ReverbUGens.scx
│   │       ├── TestUGens.scx
│   │       ├── TriggerUGens.scx       ← Select
│   │       ├── UnaryOpUGens.scx
│   │       └── UnpackFFTUGens.scx
│   └── Frameworks/
│       ├── libsndfile.dylib           4.9 MB  (必須、scsynth が依存)
│       └── libfftw3f.dylib            1.6 MB  (FFT_UGens が依存、同梱推奨)
└── (not needed)
    ├── sclang, SCIDE, SCClassLibrary, HelpSource, Qt frameworks, sounds/
```

### サイズ合計

| 構成 | サイズ |
|---|---|
| 全 plugins 同梱 (シンプル) | **~18 MB** |
| non-supernova plugins のみ (最適化) | **~13 MB** |
| SC.app 全体 | 556 MB (32x 削減) |

推奨: 全 plugins 同梱。GPL-3.0 改変扱いを避ける (plugins を選別すると modification とみなされる可能性あり)。

---

## 動作確認手順

### 1. 抽出

```bash
mkdir -p /tmp/scsynth-test/Contents/{Resources,Frameworks}
cp /Applications/SuperCollider.app/Contents/Resources/scsynth /tmp/scsynth-test/Contents/Resources/
cp -R /Applications/SuperCollider.app/Contents/Resources/plugins /tmp/scsynth-test/Contents/Resources/
cp /Applications/SuperCollider.app/Contents/Frameworks/libsndfile.dylib /tmp/scsynth-test/Contents/Frameworks/
cp /Applications/SuperCollider.app/Contents/Frameworks/libfftw3f.dylib /tmp/scsynth-test/Contents/Frameworks/
```

ディレクトリ構造を `Contents/Resources/` + `Contents/Frameworks/` の形で保つ必要がある (scsynth の `@loader_path/../Frameworks/libsndfile.dylib` 参照に対応)。

### 2. 起動

```bash
/tmp/scsynth-test/Contents/Resources/scsynth -u 57202 -i 0
```

**必須フラグ**:
- `-u <port>` : UDP port (default 57110)
- `-i 0` : input channel disable。これを省略すると異なるサンプリングレートの input/output device がある環境で sample rate mismatch で crash (今回の Mac mini で実再現)

### 3. 期待される boot log

```
*** ERROR: open directory failed '/Users/<user>/Library/Application Support/SuperCollider/synthdefs'
Number of Devices: 6
   ...
SC_AudioDriver: sample rate = 48000.000000, driver's block size = 512
SuperCollider 3 server ready.
PublishPortToRendezvous 0 57202
```

1行目の `ERROR: open directory failed` は **fatal ではない**。scsynth はユーザー synthdef dir を読もうとして失敗するが継続する。無害。

### 4. OSC 通信テスト結果

カスタム Node.js test (dgram UDP で OSC 直接エンコード) で以下を確認:

| 操作 | 期待 | 実測 |
|---|---|---|
| `/status` → `/status.reply` | OSC round-trip | ✅ `/status.reply ,iiiiiffdd` |
| `/d_recv` (orbitPlayBuf.scsyndef blob) | `/done ,s` 受信 | ✅ |
| `/b_allocRead` (kick.wav) | `/done ,sii` 受信 | ✅ |
| `/s_new orbitPlayBuf` | `/n_go` + `/n_end` 受信 | ✅ |

Test script: `/tmp/scsynth-test/test-playback.js` (本リポジトリ外)。

---

## 発見事項

### 既存コードとの整合

現 `packages/engine/src/audio/supercollider/osc-client.ts:21` は:

```ts
scsynth: '/Applications/SuperCollider.app/Contents/Resources/scsynth'
```

bundle 後はこれを拡張 install path からの相対に差し替える。`supercolliderjs` の options は `scsynth` path を受け付けるので API 変更不要。

### 既存 `numInputBusChannels: '0'` 設定

`osc-client.ts:30` で既に output device 指定時に `numInputBusChannels: '0'` を設定済。これが `-i 0` に相当。**sample rate mismatch crash を既に回避している**。

ただし output device を明示指定しない場合は未設定。bundle 版では必ず `numInputBusChannels: '0'` を default 動作にする方針推奨。

### GPL-3.0 aggregation 観点

- scsynth binary は無改変で同梱 (本検証で抽出した `cp` 結果、bit-by-bit 同一)
- plugins ディレクトリも無改変
- dylib も無改変
- IPC は OSC (現状通り) → aggregation

→ Sonic Pi 先例と同等の配置。GPL-3.0 準拠。

---

## Fallback 策 (万一動かない場合)

1. **SC.app への fallback**: bundle binary 起動失敗時に `/Applications/SuperCollider.app/Contents/Resources/scsynth` を試す
2. **手動指定**: `ORBIT_AUDIO_SCSYNTH_PATH` 環境変数 or VS Code settings `orbitscore.scsynthPath` で override
3. **エラー UX**: "OrbitScore: Check Audio Setup" コマンドで診断情報を VS Code に表示

---

## 次アクション

- Issue #134: 最小 plugin 集合の再確認と bundle manifest ドキュメント化 (必要なら non-supernova のみに絞る判断)
- Issue #135: codesign / notarize pipeline 設計 (今回の bundle 構造を固定した上で)
- Issue #136: 実装 — packages/vscode-extension に bundle 配置 + path resolution 切替
