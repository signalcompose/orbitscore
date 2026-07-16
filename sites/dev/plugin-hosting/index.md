---
title: "PH-1. Plugin Hosting 概観"
chapter-id: "PH-1"
verified-against: 5b227da
verified-at: "2026-07-17"
status: draft
---

> **Note**: 本ページは 2026-07-17 時点での著者の reading の足跡です。code が真実、本ページはその時点の理解の snapshot に過ぎません。

# PH-1. Plugin Hosting 概観

OrbitScore は CLAP / VST3 の 3rd-party プラグインを **sandbox 化された out-of-process (OOP) child**
としてホストする。本章はその全体像 — DSL 構文、フォーマット対応表、OOP hosting の仕組み — を
鳥瞰する。詳細な内部実装（child process 側の transport、shm 構造）は後続章 (PH-2, PH-3) に譲る。

## DSL 構文: 2 つの hosting 面

OrbitScore の DSL は plugin hosting を 2 つの独立した面に分ける。

- **`global.effect(spec, pluginId?)`** — マスターバスへの insert（v1 では 1 本のみ）
- **`seq.instrument(spec, pluginId?)`** — シーケンス単位の音源（v1 では 1 インスタンスのみ）

両者は同じ「宣言 → resolve → load」パターンを共有するが、許容フォーマットが異なる。

```typescript
// plugin-instrument-manager.ts:27-51
  async instrument(spec: string, pluginId?: string): Promise<void> {
    validatePluginExtension(spec, 'instrument')
    if (this.linkAudioManager.isEnabled()) {
      throw new Error('seq.instrument() cannot be used while LinkAudio is enabled in v1.')
    }

    const resolvedPath = resolvePluginPath(
      spec,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'instrument',
    )
    const existing = this.declaration
    if (existing) {
      if (existing.resolvedPath === resolvedPath && existing.pluginId === pluginId) {
        await existing.load
        if (this.audioEngine.isPluginActive?.() === false) {
          await this.issueLoad(resolvedPath, pluginId)
        }
        return
      }
      throw new Error('seq.instrument() supports one instrument instance in v1.')
    }
    await this.issueLoad(resolvedPath, pluginId)
  }
```

`global.effect()` 側は構造がほぼ同一だが、順序に注意が必要な点が異なる: extension validation →
LinkAudio gate → path resolution、の順を **意図的に** 守っている。

```typescript
// plugin-effect-manager.ts:27-44
  async effect(spec: string, pluginId?: string): Promise<void> {
    // Order is load-bearing: validate the spec, then gate on LinkAudio, and
    // only then resolve the path. A relative spec with no document context
    // yet (unsaved file) makes `resolvePluginPath` throw a "cannot resolve"
    // error; if that ran before the LinkAudio gate, it would mask the more
    // relevant LinkAudio-conflict error with a confusing resolve failure.
    validatePluginExtension(spec, 'effect')

    if (this.linkAudioManager.isEnabled()) {
      throw new Error('global.effect() cannot be used while LinkAudio is enabled in v1.')
    }

    const resolvedPath = resolvePluginPath(
      spec,
      this.audioManager.getAudioPaths(),
      this.audioManager.getDocumentDirectory(),
      'effect',
    )
```

この順序が「load-bearing」だとコメントが明言している理由は、未保存ファイル（document context
なし）で spec が相対パスだと `resolvePluginPath` が「解決できない」エラーを投げてしまい、
それが先に走ると LinkAudio 競合という本質的により重要なエラーがマスクされてしまうため。

`PluginInstrumentManager` / `PluginEffectManager` はいずれも「1 declaration のみ v1 でサポート」
という制約を共有する。2 本目の異なる spec で呼ぶと明示的にエラーを投げる（effect chain / 複数
instrument は将来対応として予約されている）。また `isPluginActive?.() === false` の自己修復分岐は、
daemon 再起動でキャッシュ上は成功扱いのまま実体が復元されていない silent failure を検知して
再ロードする防御になっている。

## フォーマット対応表

拡張子ベースの validation は `PluginRole` ごとに許容フォーマットを変える。

```typescript
// plugin-resolver.ts:21-44
export function resolvePluginPath(
  spec: string,
  audioPaths: readonly string[],
  documentDirectory: string,
  role: PluginRole,
): string {
  validatePluginExtension(spec, role)
  return resolvePathDirect(spec, audioPaths, documentDirectory)
}

export type PluginRole = 'effect' | 'instrument'

export function validatePluginExtension(spec: string, role: PluginRole): void {
  const extension = path.extname(spec).toLowerCase()
  if (extension === '.clap') return
  if (extension === '.vst3' && role === 'instrument') return
  if (extension === '.vst3' || extension === '.component') {
    throw new Error(
      `${extension} plugins are not yet supported for ${role} (reserved for future VST3/AU support).`,
    )
  }
  const expected = role === 'instrument' ? '.clap or .vst3' : '.clap'
  throw new Error(`Unknown plugin extension "${extension || '(none)'}"; expected ${expected}.`)
}
```

| Role | `.clap` | `.vst3` | `.component` (AU) |
|---|---|---|---|
| `global.effect()`（master insert） | ✅ | ❌（"reserved for future" エラー） | ❌ |
| `seq.instrument()`（音源） | ✅ | ✅ | ❌ |

`.component` (Audio Unit) はどちらの role でも未対応（"reserved for future" として明示的に
reject される）。VST3 は instrument でのみ有効 — この非対称は Issue #421（VST3 instrument
production）で instrument 側のみ先行実装されたことの反映であり、effect 側の VST3 対応は
別途スコープ。

## OOP child process 構成

daemon (`orbit-audio-daemon`) は plugin の実体（CLAP/VST3 SDK 呼び出し）を自プロセス内に
持たない。代わりに **専用の子プロセス** を spawn し、共有メモリ (shared memory) 経由で
audio/event をやり取りする。子プロセスの選択は plugin path の拡張子から決まる純関数で
行われる:

```rust
// outproc_instrument.rs:106-134
/// instrument child のフォーマット別デフォルト binary 名。VST3 だけが専用 child を持ち、
/// それ以外（.clap・raw .dylib CLAP 等）は従来どおり CLAP child が担当する。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstrumentPluginFormat {
    Clap,
    Vst3,
}

impl InstrumentPluginFormat {
    /// 拡張子 `.vst3`（大文字小文字不問）のみ VST3。**それ以外はすべて Clap** —
    /// CLAP は VST3 対応前から唯一サポートされていた instrument フォーマットだった
    /// ため、未知拡張子のフォールバック先として妥当。一例として、CLAP gated テストは
    /// 未バンドルの raw `.dylib`（clap-test-synth）を attach するため、ここで未知
    /// 拡張子を reject すると既存経路が壊れる（本ブランチの実機 gated RUN で検出済み）。
    /// 不正な plugin path の失敗は従来どおり child 側の load エラーとして表面化する。
    fn from_plugin_path(path: &Path) -> Self {
        match path.extension().and_then(|extension| extension.to_str()) {
            Some(extension) if extension.eq_ignore_ascii_case("vst3") => Self::Vst3,
            _ => Self::Clap,
        }
    }

    fn default_child_name(self) -> &'static str {
        match self {
            Self::Clap => "orbit-clap-instrument-child",
            Self::Vst3 => "orbit-vst3-instrument-child",
        }
    }
}
```

daemon 側の TypeScript validation (`validatePluginExtension`) と Rust 側の
`InstrumentPluginFormat::from_plugin_path` は **一致していない** ことに注意。TS 側は
`.clap`/`.vst3` 以外を reject するが、Rust 側は未知拡張子を CLAP にフォールバックする。
これは意図的な非対称で、CLAP gated テストが未バンドルの raw `.dylib`（拡張子なし相当）を
attach する既存経路を壊さないための設計判断だとコメントされている。

child binary の選択自体は、既定名（`orbit-clap-instrument-child` / `orbit-vst3-instrument-child`）
のときだけ同ディレクトリで読み替える対称・冪等な純関数として実装されている:

```rust
// outproc_instrument.rs:136-159
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
    let is_default_name = matches!(
        current_child_exe.file_name().and_then(|name| name.to_str()),
        Some("orbit-clap-instrument-child") | Some("orbit-vst3-instrument-child")
    );
    if !is_default_name {
        return current_child_exe.to_path_buf();
    }
    let desired = InstrumentPluginFormat::from_plugin_path(plugin_path).default_child_name();
    match current_child_exe.parent() {
        Some(dir) => dir.join(desired),
        None => PathBuf::from(desired),
    }
}
```

「current_exe から再導出しない」判断はテストハーネス互換性のための実装都合であり、
「明示指定された custom binary は上書きしない」ガードは gated テストの config 直指定を
壊さないための防御である。この 2 点は PH-3（VST3 instrument hosting）章で詳しく扱う。

effect 側にも対応する OOP child（`orbit-clap-effect-child` 系、`outproc_effect.rs`）が
存在するが、現時点で effect は CLAP のみ対応のため VST3 child は無い。effect 側の詳細は
PH-4 章に譲る。

## Try it: `seq.instrument("SynthOracle.vst3")` を鳴らす

以下は Issue #421（VST3 instrument production）の実機 E2E で実証済みの手順（WORK_LOG 6.258）。

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
DSL → `LoadPlugin(role=instrument)` → 拡張子ベースの child 選択 → `orbit-vst3-instrument-child`
→ `IEventList` 経由の note on/off → sine 発音 → master bus、という経路全体が客観的に実証できる。

**期待値**: capture peak = **0.25000**（`SynthOracle` の既知振幅との厳密一致。WORK_LOG 6.258
で実機確認済み）。

> **注意（既知の落とし穴）**: `play()` はパターンの buffering のみを行い、実際の発音には
> `RUN(seq)` が必要（WORK_LOG に既出の「RUN/LOOP 忘れ」silent 失敗パターン）。

## Sources

- `packages/engine/src/core/global/plugin-resolver.ts:21-44` — `resolvePluginPath` / `validatePluginExtension`（role 別フォーマット許容ロジック）
- `packages/engine/src/core/global/plugin-instrument-manager.ts:27-51` — `PluginInstrumentManager.instrument()`
- `packages/engine/src/core/global/plugin-effect-manager.ts:27-44` — `PluginEffectManager.effect()`（validation 順序の load-bearing コメント）
- `rust/crates/orbit-audio-daemon/src/outproc_instrument.rs:106-167` — `InstrumentPluginFormat` と `child_exe_for_attach`（フォーマット別 child 選択の純関数）
- [`docs/development/WORK_LOG.md`](https://github.com/signalcompose/orbitscore/blob/main/docs/development/WORK_LOG.md) 6.258 — VST3 instrument production の実機 E2E 記録（capture peak 0.25000）
- Epic [#424](https://github.com/signalcompose/orbitscore/issues/424) — plugin hosting DoD 全体像
- Issue [#421](https://github.com/signalcompose/orbitscore/issues/421) — VST3 instrument production
