---
title: "PH-1. Plugin Hosting 概観"
chapter-id: "PH-1"
verified-against: 69dc968
verified-at: "2026-09-01"
status: draft
---

> **Note**: 本ページは 2026-09-01 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# PH-1. Plugin Hosting 概観

OrbitScore は CLAP / VST3 の 3rd-party プラグインを **sandbox 化された out-of-process (OOP) child**
としてホストします。本章はその全体像 — DSL 構文、フォーマット対応表、OOP hosting の仕組み — を
鳥瞰します。内部実装の深掘りは後続章に譲ります: child process 側の transport と shm 構造は
[RE-2](/rust-engine/oop-children)、plugin UI の window 配線は [PH-2](/plugin-hosting/plugin-ui)、
カタログ名解決と差し替えは [PH-3](/plugin-hosting/catalog)、ラック（チェーンを値として書く形）は
[SC-1](/signal-chain/) です。

この章は 2026-07-17 に書いたものを 2026-09-01 の commit `69dc968` に合わせて読み直したものです。
その間に DSL 面は「カタログ名指し（#463）」「state 復元（#540）」「差し替え（#618 / #625）」
「ラック（#628）」「plugin UI（#617 / #633）」を吸収し、TS 側の manager は共通基盤へ畳まれ、
effect 側にも VST3 と rack child が入りました。

## DSL 構文: hosting の面

2026-07-17 時点では `global.effect()` と `seq.instrument()` の 2 面でしたが、2026-09-01 時点の
core spec（PH.1〜PH.6 / PC.* / MX.*）が定める面は次のとおりです。

| DSL | 役割 | spec | 補足 |
|---|---|---|---|
| `seq.instrument(spec[, pluginId][, statePath])` | シーケンス単位の音源。seq ごとに独立インスタンス | PH.1 / PH.4 | `.vstpreset` / `.state` で音色を復元（#540 P2・VST3 のみ）。異なる spec は prepare-commit 型で差し替え（#618） |
| `global.effect(spec \| rack[, pluginId])` | master bus の insert | PH.2 | 単発形は 1 要素のラックへ脱糖。複数は `["A", Gain(db: -6)]` の配列形（#628・SC.10） |
| `seq.effect(spec \| rack[, pluginId])` | シーケンス単位の insert（[RE-3](/rust-engine/insert-bus)） | PH.2b / PH.2d | 異なる spec は差し替え。削除は配列から消す（#625 → #628） |
| `sum(name).effect(...)` / `aux(name).effect(...)` | mixer bus の insert | MX.2 / MX.3 | [SC-2](/signal-chain/mixer-audio-line) |
| `seq.ui([name][, open])` | plugin UI window を開く / 閉じる | PH.2c | 無引数 = instrument の UI。名前一致の insert はすべて開く（#617 / #628） |
| カタログ名（`effect("TAL Reverb 4")` / `"vendor/name"` / `"vst3/name"`） | path を書かずに名前で解決 | PC.2 | path-direct 形（`./` `../` `~/` `/` 開始・既知拡張子で終わる）は従来どおり path 解決 |

`spec` が path かカタログ名かは `isPluginPathSpec` が判別します。audio 系の「`/` を含めば path」という
規則は再利用しません — vendor 修飾 `"TAL Software/TAL Reverb 4"` は `/` を含むがカタログ名だからです。

```typescript
// packages/engine/src/core/global/plugin-resolver.ts:68-80
const PATH_DIRECT_PREFIXES = ['./', '../', '~/', '/']

/**
 * PC.2 discriminator: path-direct specs start with `./`/`../`/`~/`/`/` or end with a known
 * plugin extension; everything else is a catalog name. Deliberately does NOT reuse audio's
 * `looksLikePath()` ("contains `/`" = path) — a vendor-qualified catalog name like
 * `"TAL Software/TAL Reverb 4"` contains `/` but is not a path.
 */
export function isPluginPathSpec(spec: string): boolean {
  if (PATH_DIRECT_PREFIXES.some((prefix) => spec.startsWith(prefix))) return true
  const lower = spec.toLowerCase()
  return KNOWN_PLUGIN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
```

## TS 側 manager: 4 つの manager が 1 つの基盤に畳まれた

2026-07-17 時点では `PluginInstrumentManager` と `PluginEffectManager` が「validate → LinkAudio gate →
resolve → eager load → 冪等再宣言」を各々 ~15 行ずつ複製していました。#468 / #527 でこれらは
`effect-slot.ts` の `EffectChainMap`（宣言の帳簿と per-key 直列化キュー）と `BusPool` に一本化され、
`SequenceEffectManager` / `MixerManager` も同じ基盤に乗っています。

instrument 側は `EffectChainMap.declare()` を使う「単一 instrument の旧経路」で、seq ごとに
`plugin:<seqName>` という instance ID を持ちます。

```typescript
// packages/engine/src/core/global/plugin-instrument-manager.ts:53-91
  async instrument(
    seqName: string,
    spec: string,
    pluginId?: string,
    statePath?: string,
  ): Promise<void> {
    // 拡張子検証は path-direct spec にのみ適用する（#463 C2: カタログ名はここで弾かず、
    // resolvePluginSpec のカタログ解決に委ねる — effect-slot.ts の resolveEffectSpec と同型）。
    if (isPluginPathSpec(spec)) {
      validatePluginExtension(spec, 'instrument')
    }
    if (this.linkAudioManager.isEnabled()) {
      throw new Error('seq.instrument() cannot be used while LinkAudio is enabled in v1.')
    }

    const resolved = resolvePluginSpec(
      spec,
      pluginId,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'instrument',
    )
    await this.slots.declare(
      seqName,
      {
        role: 'instrument',
        bus: undefined,
        normalizedName: normalizePluginInstanceName(spec),
        resolvedPath: resolved.path,
        pluginId: resolved.pluginId,
        // note 側 `resolveNoteTarget()` の port（`plugin:<seqName>`）と同じ規約。
        instance: `plugin:${seqName}`,
        // #540 P2: 保存済み state（音色）。相対パスは document directory 基準で解決する。
        statePath: statePath === undefined ? undefined : this.resolveStatePath(statePath),
      },
      () =>
        `Sequence '${seqName}' already has an instrument instance; replacing it requires the Rust engine backend.`,
    )
  }
```

effect 側は `applyRack()` を使うラック経路です。`global.effect()` は驚くほど短くなりました。

```typescript
// packages/engine/src/core/global/plugin-effect-manager.ts:49-61
  async effect(value: string | RackRecipe, pluginId?: string): Promise<void> {
    const recipe = toRackRecipe(value, pluginId)
    if (this.linkAudioManager.isEnabled()) {
      throw new Error('global.effect() cannot be used while LinkAudio is enabled in v1.')
    }
    const rack = resolveEffectRack(
      recipe,
      { audioManager: this.audioManager, linkAudioManager: this.linkAudioManager },
      'global.effect() cannot be used while LinkAudio is enabled in v1.',
    )
    await this.slots.applyRack('master', rack)
    this.hasDeclared = true
  }
```

2026-07-17 時点で「順序が load-bearing」とコメントされていた「validate → LinkAudio gate →
resolve」の並びは、`resolveEffectSpec` に移って今も守られています。未保存ファイル（document
context なし）で spec が相対パスだと `resolvePluginPath` が「解決できない」エラーを投げてしまい、
それが先に走ると LinkAudio 競合という本質的により重要なエラーがマスクされるためです。
#463 C2 で、拡張子検証は path-direct spec にだけ掛けるようになりました（カタログ名は拡張子を
持たないので、ここで弾くとカタログ解決に到達できない）。

```typescript
// packages/engine/src/core/global/effect-slot.ts:33-61
/**
 * effect spec の共通前処理。順序は load-bearing（PluginEffectManager 由来）:
 * spec 検証 → LinkAudio gate → パス解決。未保存ファイル等で resolve が
 * 「cannot resolve」を投げる前に、より本質的な LinkAudio 競合エラーを出すため。
 * 拡張子検証（`validatePluginExtension`）は path-direct spec にのみ適用する
 * （#463 C2: カタログ名はここで弾かず、`resolvePluginSpec` のカタログ解決に委ねる）。
 */
export function resolveEffectSpec(
  spec: string,
  pluginId: string | undefined,
  deps: { audioManager: AudioManager; linkAudioManager: LinkAudioManager },
  linkAudioErrorMessage: string,
  catalogPathOverride?: string,
): ResolvedPluginSpec {
  if (isPluginPathSpec(spec)) {
    validatePluginExtension(spec, 'effect')
  }
  if (deps.linkAudioManager.isEnabled()) {
    throw new Error(linkAudioErrorMessage)
  }
  return resolvePluginSpec(
    spec,
    pluginId,
    deps.audioManager.getAudioPaths(),
    deps.audioManager.getDocumentDirectory(),
    'effect',
    catalogPathOverride,
  )
}
```

`EffectChainMap` の「同一 spec の再宣言は冪等（no-op）・respawn 後の stale cache は
`isPluginActive?.() === false` を見て再ロード（self-heal）・異なる spec は差し替え」という規則は
[PH-3](/plugin-hosting/catalog) 章で扱います。

## フォーマット対応表

拡張子ベースの validation は `plugin-resolver.ts` にあります。2026-07-17 時点では「`.vst3` は
instrument のみ」という role 非対称がありましたが、#552 で effect 側にも per-plugin の format
解決（`orbit-vst3-effect-child`）が入り、role によらず `.clap` / `.vst3` を受理します。

```typescript
// packages/engine/src/core/global/plugin-resolver.ts:39-66
export type PluginRole = 'effect' | 'instrument'

/** 実際にロードできる拡張子。新 format のサポートを足す時はここに追加する。 */
const SUPPORTED_PLUGIN_EXTENSIONS = ['.clap', '.vst3']
/** plugin ファイルとしては認識するが v1 ではロードできない拡張子（AU 予約）。 */
const RESERVED_PLUGIN_EXTENSIONS = ['.component']
/**
 * plugin ファイルパスとして**認識する**拡張子 = ロード可能 + 予約。
 * ロード可否とは別概念なので、`validatePluginExtension` は上の2つから判定する
 * （この配列だけを見ると「予約拡張子もロードできる」と誤読するため）。
 */
export const KNOWN_PLUGIN_EXTENSIONS = [
  ...SUPPORTED_PLUGIN_EXTENSIONS,
  ...RESERVED_PLUGIN_EXTENSIONS,
]
const KNOWN_PLUGIN_FORMATS = SUPPORTED_PLUGIN_EXTENSIONS.map((extension) => extension.slice(1))

export function validatePluginExtension(spec: string, role: PluginRole): void {
  const extension = path.extname(spec).toLowerCase()
  if (SUPPORTED_PLUGIN_EXTENSIONS.includes(extension)) return
  if (RESERVED_PLUGIN_EXTENSIONS.includes(extension)) {
    throw new Error(
      `${extension} plugins are not yet supported for ${role} (reserved for future AU support).`,
    )
  }
  const expected = SUPPORTED_PLUGIN_EXTENSIONS.join(' or ')
  throw new Error(`Unknown plugin extension "${extension || '(none)'}"; expected ${expected}.`)
}
```

| spec の形 | `.clap` | `.vst3` | `.component` (AU) | 備考 |
|---|---|---|---|---|
| path-direct（`seq.instrument()` / `global.effect()` / `seq.effect()` / `sum().effect()` 共通） | ✅ | ✅ | ❌（"reserved for future AU support" エラー） | 未知拡張子はエラー |
| カタログ名 | ✅ | ✅ | スキャン対象外（PC.5） | 同名が両 format にあれば **CLAP > VST3**（PH.3 / PC.2） |

`.component`（Audio Unit）は「plugin ファイルとして認識はするがロードできない」予約拡張子で、
`KNOWN_PLUGIN_EXTENSIONS`（認識）と `SUPPORTED_PLUGIN_EXTENSIONS`（ロード可）を分けているのは
この 2 つを混同させないためです。

## OOP child process 構成

daemon (`orbit-audio-daemon`) は plugin の実体（CLAP/VST3 SDK 呼び出し）を自プロセス内に
持ちません。代わりに **専用の子プロセス** を spawn し、共有メモリ (shared memory) 経由で
audio/event をやり取りします。spawn し得る child は `SPAWNABLE_CHILD_BINARIES` に列挙されています
（一覧と役割は [RE-2](/rust-engine/oop-children) の表を参照）。

```rust
// rust/crates/orbit-audio-daemon/src/lib.rs:84-93
pub const SPAWNABLE_CHILD_BINARIES: &[&str] = &[
    // effect: #628 以降は rack child 1 本がチェーン全体を持つ（format で分岐しない）。
    "orbit-effect-rack-child",
    // effect（退役予定・#628 で到達不能になったが、退役 PR まで配布は続ける）。
    "orbit-clap-effect-child",
    "orbit-vst3-effect-child",
    // instrument: format ごとに child が分かれる（1 instrument = 1 child）。
    "orbit-clap-instrument-child",
    "orbit-vst3-instrument-child",
];
```

2026-09-01 時点の対応は次のとおりです。

| role | child | 選び方 |
|---|---|---|
| effect（master / seq / sum / aux の全 bus） | `orbit-effect-rack-child`（#628） | 1 child がチェーン全体を直列に回す。CLAP/VST3 の分岐は child の中 |
| instrument | `orbit-clap-instrument-child` / `orbit-vst3-instrument-child` | plugin path の拡張子から純関数で選ぶ（#421・#552） |

instrument 側の child 選択は、`.vst3`（大文字小文字不問）だけを VST3 とし、それ以外はすべて
CLAP child に倒す純関数です。2026-07-17 時点では `outproc_instrument.rs` の中に閉じていましたが、
#552 で「規則」は `outproc_child_exe.rs` に共通化され、instrument 側は「binary 名の対」だけを持ちます
（#548 で「片方だけ入っていなかった」バグが出たことが共通化の動機です）。

```rust
// rust/crates/orbit-audio-daemon/src/outproc_child_exe.rs:10-56
/// plugin path が VST3 か。**未知拡張子は VST3 ではない**（= CLAP へフォールバックする）。
///
/// CLAP は VST3 対応前から唯一サポートされていた format なので、未知拡張子のフォールバック先
/// として妥当。gated テストは未バンドルの raw `.dylib`（clap-test-synth）を attach するため、
/// ここで未知拡張子を reject すると既存経路が壊れる。不正な plugin path の失敗は従来どおり
/// child 側の load エラーとして表面化する。
pub(crate) fn is_vst3_plugin_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("vst3"))
}

/// attach する plugin に合わせて child binary を読み替える（純関数）。
///
/// - `current_child_exe` の file name が `clap_name` / `vst3_name` のどちらでもない場合は
///   **明示指定と見なして触らない**（`ORBIT_*_CHILD_BIN` override と gated テストの
///   config 直指定を保護する）。
/// - デフォルト名の場合は**同じディレクトリ**でフォーマットに応じた binary に読み替える。
///   `current_exe` からの再導出はしない（テストハーネスでは `current_exe` が
///   `target/debug/deps/` 配下になり sibling 解決が壊れるため）。
/// - **冪等かつ対称**: retryable な attach 失敗で `ChildLaunch` が再利用されても毎回この
///   読み替えが走るので、`.vst3` → `.clap` の attach し直しで元の child に戻る。
///
/// 🔴 デフォルト名は呼び出し側が `default_child_name()` から渡すこと（手打ちリテラルにしない）。
/// 決め打ちだと child をリネームしたとき判定が常に false へ倒れ、**per-plugin のフォーマット
/// 切替が無音のまま無効化される**。
pub(crate) fn child_exe_for_attach(
    current_child_exe: &Path,
    plugin_path: &Path,
    clap_name: &'static str,
    vst3_name: &'static str,
) -> PathBuf {
    let current_name = current_child_exe.file_name().and_then(|name| name.to_str());
    let is_default_name = current_name.is_some_and(|name| name == clap_name || name == vst3_name);
    if !is_default_name {
        return current_child_exe.to_path_buf();
    }
    let desired = if is_vst3_plugin_path(plugin_path) {
        vst3_name
    } else {
        clap_name
    };
    match current_child_exe.parent() {
        Some(dir) => dir.join(desired),
        None => PathBuf::from(desired),
    }
}
```

```rust
// rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:154-191
/// instrument child のフォーマット別デフォルト binary 名。VST3 だけが専用 child を持ち、
/// それ以外（.clap・raw .dylib CLAP 等）は従来どおり CLAP child が担当する。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstrumentPluginFormat {
    Clap,
    Vst3,
}

impl InstrumentPluginFormat {
    fn default_child_name(self) -> &'static str {
        match self {
            Self::Clap => "orbit-clap-instrument-child",
            Self::Vst3 => "orbit-vst3-instrument-child",
        }
    }
}

/// attach する plugin の拡張子から instrument child binary を選ぶ（純関数・unit テスト対象）。
///
/// - `current_child_exe` の file name がフォーマット別デフォルト名（clap/vst3 child）で
///   ない場合は**明示指定と見なして触らない**（gated テストの config 直指定・
///   `ORBIT_INSTRUMENT_CHILD_BIN` override を保護）。
/// - デフォルト名の場合は**同じディレクトリ**でフォーマットに応じた binary に読み替える。
///   `current_exe` からの再導出はしない（テストハーネスでは current_exe が
///   `target/debug/deps/` 配下になり sibling 解決が壊れるため）。retryable attach 失敗で
///   `ChildLaunch` が再利用されても、毎回この読み替えが走るので .vst3 → .clap の
///   attach し直しで元の child に戻る（対称・冪等）。
pub(crate) fn child_exe_for_attach(current_child_exe: &Path, plugin_path: &Path) -> PathBuf {
    // 規則そのものは effect と共有する（`outproc_child_exe`）。ここが持つのは
    // 「instrument の binary 名の対」だけ。
    crate::outproc_child_exe::child_exe_for_attach(
        current_child_exe,
        plugin_path,
        InstrumentPluginFormat::Clap.default_child_name(),
        InstrumentPluginFormat::Vst3.default_child_name(),
    )
}

```

TypeScript 側の validation（`validatePluginExtension`）と Rust 側の `is_vst3_plugin_path` は
**一致していない**ことに注意してください。TS 側は path-direct spec の未知拡張子を reject しますが、
Rust 側は未知拡張子を CLAP にフォールバックします。これは意図的な非対称で、CLAP gated テストが
未バンドルの raw `.dylib`（clap-test-synth）を attach する既存経路を壊さないための設計判断だと
コメントされています。

child binary の読み替えは、既定名（`orbit-clap-instrument-child` / `orbit-vst3-instrument-child`）
のときだけ同ディレクトリで行う対称・冪等な純関数です。「`current_exe` から再導出しない」判断は
テストハーネス互換性（`target/debug/deps/` 配下では sibling 解決が壊れる）のための実装都合で、
「明示指定された custom binary は上書きしない」ガードは gated テストの config 直指定と
`ORBIT_*_CHILD_BIN` override を壊さないための防御です。

effect 側は #628 以降、format で child を分岐しません。`default_rack_child_exe` が daemon と同じ
ディレクトリの `orbit-effect-rack-child` を既定にします。

```rust
// rust/crates/orbit-audio-daemon/src/outproc_effect.rs:451-458
/// （spike の sibling-of-exe を踏襲・設計 §4.5）。インストール時は daemon と child が並んで置かれる前提。
fn default_rack_child_exe() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current_exe has no parent directory".to_string())?;
    Ok(dir.join("orbit-effect-rack-child"))
}
```

`orbit-clap-effect-child` / `orbit-vst3-effect-child` は #628 で到達不能になりましたが、退役 PR
まで配布は続きます（`SPAWNABLE_CHILD_BINARIES` のコメント）。

## Try it: `seq.instrument("SynthOracle.vst3")` を鳴らす

以下は Issue #421（VST3 instrument production）の実機 E2E で実証済みの手順です（WORK_LOG 6.258）。

```
var global = init GLOBAL
global.tempo(100)
global.beat(4 by 4)
global.key("C")
global.start()

var synth = init global.seq
synth.instrument("/path/to/SynthOracle.vst3")
synth.octave(4)
synth.vel(96)
synth.length(1)

synth.play(1, 3, 5, 8)

RUN(synth)
```

配布構成の release daemon + `cli-audio.js` を `ORBIT_CAPTURE_WAV` 有効で実行すると、
DSL → `LoadPlugin(role=instrument, instance="plugin:synth")` → 拡張子ベースの child 選択 →
`orbit-vst3-instrument-child` → `IEventList` 経由の note on/off → sine 発音 → master bus、
という経路全体が客観的に実証できます。

**期待値**: capture peak = **0.25000**（`SynthOracle` の既知振幅との厳密一致。WORK_LOG 6.258
で実機確認済み・2026-07-17。2026-09-01 の再読では再実測していません）。

ユーザーと同じ動線（OrbitStudio + MCP）を通す E2E は `tests/e2e/orbitstudio-mcp-gated.spec.ts` に
積まれており、`npm run test:e2e:gated` で回します（[RE-4](/rust-engine/capture-verification)）。

> **注意（既知の落とし穴）**: `play()` はパターンの buffering のみを行い、実際の発音には
> `RUN(seq)` が必要です（WORK_LOG に既出の「RUN/LOOP 忘れ」silent 失敗パターン）。

## 次の深掘り候補

- `EffectChainMap.declare()` の self-heal（`isPluginActive`）が respawn 後に正しく再ロードすることの E2E 上の確認手段
- `seq.instrument()` の `statePath`（#540 P2）が `LoadPlugin.state` として child 起動時にどう復元されるか
- `orbit-effect-rack-child` の中で CLAP と VST3 をどう同居させているか（`rack_wire.rs`）
- `.component`（AU）対応を足すときに触る場所の列挙（`RESERVED_PLUGIN_EXTENSIONS` / カタログ scanner / PH.3）

## Sources

- `packages/engine/src/core/global/plugin-resolver.ts:29-80` — `resolvePluginPath` / `validatePluginExtension` / `isPluginPathSpec`（拡張子とカタログ名の判別）
- `packages/engine/src/core/global/plugin-resolver.ts:238-260` — `resolvePluginSpec`（カタログ名と pluginId 引数の併用エラー）
- `packages/engine/src/core/global/plugin-instrument-manager.ts:22-91` — `PluginInstrumentManager.instrument()`（`plugin:<seqName>` instance ID・statePath）
- `packages/engine/src/core/global/plugin-effect-manager.ts:15-62` — `PluginEffectManager.effect()`（ラック経路）
- `packages/engine/src/core/global/effect-slot.ts:33-61` — `resolveEffectSpec`（load-bearing な validate → gate → resolve の順序）
- `rust/crates/orbit-audio-daemon/src/lib.rs:84-93` — `SPAWNABLE_CHILD_BINARIES`
- `rust/crates/orbit-audio-daemon/src/outproc_child_exe.rs:1-64` — child binary 選択の共通規則（#552）
- `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:154-199` — `InstrumentPluginFormat` / `child_exe_for_attach` / `default_child_exe`
- `rust/crates/orbit-audio-daemon/src/outproc_effect.rs:451-458` — `default_rack_child_exe`
- [`docs/core/INSTRUCTION_ORBITSCORE_DSL.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/core/INSTRUCTION_ORBITSCORE_DSL.md) PH.1〜PH.6 / PC.1〜PC.5 — plugin hosting と catalog の DSL 規範
- [`docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md) SC.10 — ラック形の正本
- [`docs/archive/WORK_LOG_2026-07.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/archive/WORK_LOG_2026-07.md) 6.258 — VST3 instrument production の実機 E2E 記録（capture peak 0.25000）
- Epic [#424](https://github.com/signalcompose/orbitscore/issues/424) — plugin hosting DoD 全体像
- Issue [#421](https://github.com/signalcompose/orbitscore/issues/421) — VST3 instrument production
- Issue [#463](https://github.com/signalcompose/orbitscore/issues/463) — plugin catalog と名前指し
- Issue [#552](https://github.com/signalcompose/orbitscore/issues/552) — effect 側の per-plugin format 解決
- Issue [#628](https://github.com/signalcompose/orbitscore/issues/628) — effect rack child
