# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.2.1] - 2026-09-18

利用者に届く変化は **cold install した `.vsix` でドキュメントが読めるようになったこと** 1 点。DSL・wire・出力の意味論は変更なし。

### Fixed

- 🔴 **エンドユーザー向け学習サイト (`sites/user/`) が `.vsix` に同梱されておらず、cold install した利用者が Docs パネルを開けなかった** ([`#954`](https://github.com/signalcompose/orbitscore/issues/954) / [`#955`](https://github.com/signalcompose/orbitscore/pull/955))
  - 出荷済み 4.2.0 の `.vsix` を展開したところ `sites/` のエントリが **0 件**だった。それにもかかわらず `mcp-server.ts` のパス解決がモノレポのルートを決め打ちしていたため、Marketplace / GitHub Release から入れた利用者には機能そのものが届いていなかった
  - モノレポ / 同梱バンドルの両方を候補にするパス解決 (`resolveUserDocsLocation`) へ変更。モノレポを先に見るので、開発時の挙動は変わらない
  - ビルド時に `sites/user/` の Markdown と built dist を `.vsix` へコピーする (`scripts/copy-user-site.sh`)。**`.vsix` は +2.5 MB**
  - この経路の実機 E2E が 1 本も無かったため、cold install した `.vsix` に対する同梱チェックを追加した

### Added

- **`get_user_doc` / `search_user_docs`** — LLM が DSL の使い方（user サイト）を読む MCP ツール ([`#954`](https://github.com/signalcompose/orbitscore/issues/954))
  - これまで docs 系の MCP ツールは `get_dev_doc`（実装読解ノート）だけで、**利用者と LLM が使う側のサイトに入口が無かった**

### Changed

- dev サイト (`sites/dev/`) は **`.vsix` に同梱しない**方針を明文化した。実装読解ノートは引用でコードに接地しており、ソースが手元に無いと引用先を確かめられないため。cold install では黙って null を返すのをやめ、公開 URL (https://signalcompose.github.io/orbitscore/dev/) を案内する

## [4.2.0] - 2026-09-14

拡張のみの機能追加リリース。DSL・wire・出力の意味論は変更なし。詳細は [`docs/development/WORK_LOG.md`](docs/development/WORK_LOG.md)（"chore(release): bump the extension to 4.2.0"）を参照。

### Added

- **プラグイン UI: 譜面上のプラグイン名を右クリックしてその 1 インスタンスだけの UI を開く経路** ([`#939`](https://github.com/signalcompose/orbitscore/issues/939))
  - 従来 DSL の `ui("name")` は同名プラグインの挿入をすべて開いてしまい、個別に開く経路がなかった
- **プラグイン UI ウィンドウが VS Code のフォーカスに追従して floating するように変更**（VS Code が最前面のときだけ最前面表示。DAW と同様の挙動） ([`#940`](https://github.com/signalcompose/orbitscore/issues/940))

## [4.1.0] - 2026-09-13

### Fixed

- 🔴 **`global.gain()` / ミキサーの `pan` 実装が audio を誤って約 3 dB 減衰させていた不具合を修正** ([`#922`](https://github.com/signalcompose/orbitscore/issues/922))
  - 修正により **audio の出力レベルが約 +3 dB 上がる**（実質的な音量変化のため patch ではなく minor リリース）
  - 副作用として **ヘッドルームが約 3 dB 減る**（リミッタの無い系では、重ねたミックスが 0 dBFS に近づきやすくなる）
  - `pan` がフルスケールを超えて信号を増幅することがなくなった

既存の譜面（DSL のテキスト）を書き換える必要はない。詳細は [`docs/archive/WORK_LOG_2026-09.md`](docs/archive/WORK_LOG_2026-09.md)（"chore(release): bump the extension to 4.1.0"）を参照。

## [4.0.1] - 2026-09-12

### Changed

- Rust コードベースを複数の crate へ分割（内部リファクタリングのみ） ([`#888`](https://github.com/signalcompose/orbitscore/issues/888))
  - DSL・振る舞い・出力の意味論への変更は無し。patch リリース

## [4.0.0] - 2026-09-12

### Breaking Changes

- 🔴 **暗黙の master バス終端を廃止**（"テキストが完全な真実" 原則） ([`#883`](https://github.com/signalcompose/orbitscore/issues/883))
  - 従来、出力経路 (`.output()` / `.send()` 等) を 1 つも書かなくても `kick.play()` は暗黙的に master へ届いていた
  - 新挙動: 出口を明示しない audio / instrument や、出口を持たない sum / aux バスは **無音になる**（master への暗黙のフォールバックが無くなった）
  - 既存の譜面が暗黙 master 終端に依存していた場合、`.output()` を明示しないと鳴らなくなる（下位互換なし）
  - `program()` の暗黙的な出力合成も削除（`[rack]` の前置記法は残る）
  - VS Code 診断: 出口が無い `.play()` に Warning (`output-missing`)、aux send のみで dry が未経路の場合に Information (`dry-not-routed`) を表示し、いずれも `.output()` の quick fix を提供
- `DSL_VERSION` を `1.2` → `2.0` に更新

## [3.0.0] - 2026-09-11

owner 裁定によりネイティブ移行前の拡張版ラインを凍結した安定版リリース。v2.0.0 以降、Rust オーディオデーモンへの完全移行・プラグインホスティング・ミキサーグラフなど、SuperCollider バックエンドを前提としない新しい実行基盤へ大規模に置き換えられた。詳細な PR 一覧は [`docs/archive/WORK_LOG_2026-07.md`](docs/archive/WORK_LOG_2026-07.md) / [`WORK_LOG_2026-08.md`](docs/archive/WORK_LOG_2026-08.md) / [`WORK_LOG_2026-09.md`](docs/archive/WORK_LOG_2026-09.md) を参照(本エントリはコミット単位までは網羅していない)。

### Breaking Changes

- 🔴 **`send()` の第 2 引数（送出量）を線形係数から dB へ変更** ([`#611`](https://github.com/signalcompose/orbitscore/issues/611))
  - 既存譜面の `send(bus, 0.5)`（従来: 50%）は新仕様では `+0.5 dB` として解釈されるため、意味が変わる
  - `output(dest, thru, db)` の導入、`pan` のライン要素化もあわせて行われた
- 🔴 **SuperCollider バックエンドの完全撤去に伴う設定 / コマンドの削除** ([`#502`](https://github.com/signalcompose/orbitscore/issues/502))
  - `ORBITSCORE_ENGINE` 環境変数を削除
  - VS Code 設定 `orbitscore.engine` / `orbitscore.scsynthPath` を削除
  - VS Code コマンド `Force Kill scsynth` / MCP ツール `force_kill_scsynth` を削除
  - 出荷 `.vsix` から `scsynth` / SuperCollider 関連ファイルを完全に除去（Rust `orbit-audio-daemon` が唯一のオーディオバックエンドに）
- `DSL_VERSION` を `1.1` → `1.2` に更新

### Added

v2.0.0 以降に積まれた主な機能（網羅的な列挙ではない）:

- **Rust オーディオデーモン `orbit-audio-daemon` への完全移行**（`cpal` ベース・WebSocket IPC） ([`#108`](https://github.com/signalcompose/orbitscore/issues/108))
- **プラグインホスティング**: CLAP / VST3 プラグインを out-of-process child として起動し、UI ウィンドウとエフェクト / インストゥルメントラックを提供 ([`#395`](https://github.com/signalcompose/orbitscore/issues/395), [`#416`](https://github.com/signalcompose/orbitscore/issues/416), [`#628`](https://github.com/signalcompose/orbitscore/issues/628))
- **ミキサーグラフ**: sum / aux バスと `send` によるバスルーティング、per-sequence effect insert ([`#337`](https://github.com/signalcompose/orbitscore/issues/337), [`#459`](https://github.com/signalcompose/orbitscore/issues/459), [`#434`](https://github.com/signalcompose/orbitscore/issues/434))
- **プラグインカタログ**: インストール済み CLAP / VST3 の起動時スキャンと管理 ([`#463`](https://github.com/signalcompose/orbitscore/issues/463))
- **import / project システム**: 複数ファイルにまたがるプロジェクト構成 (`project.yaml`) ([`#456`](https://github.com/signalcompose/orbitscore/issues/456))
- **状態の永続化**: プロジェクト状態の自動保存 / 復元 ([`#541`](https://github.com/signalcompose/orbitscore/issues/541), [`#577`](https://github.com/signalcompose/orbitscore/issues/577))
- **LinkAudio**: Ableton Link 経由のオーディオルーティング（🔴 出荷ビルドでは egress が無効化されている）

### Removed

- SuperCollider バックエンド opt-out 経路一式（上記 Breaking Changes 参照）

## [2.0.0] - 2026-06-19

> **Note**: このバンプは semver の破壊的変更ではなく、**製品ポジショニング判断**として major 番号を採用したもの。v1.1.1 以降に積まれた変更はすべて追加的（既存譜面を壊さない）で、厳密な semver では 1.2.0 に相当するが、MIDI 出力という新しいピラーと録音（session log）機構の追加を「世代交代」とみなしてプロジェクトの判断で 2.0.0 とした。詳細は [`docs/archive/WORK_LOG_2026-06.md`](docs/archive/WORK_LOG_2026-06.md)（6.116 エントリ）を参照。v2.0.0 は post-2.0 のネイティブアプリ移行前における**最後の機能追加 .vsix リリース**という位置付けだった。

### Added

- **MIDI 出力**: Pitch DSL Phase 1（度数解決・MIDI ノート生成） ([`#228`](https://github.com/signalcompose/orbitscore/issues/228))
- **Pitch DSL**: Phase 0（検証）・Phase R・Phase 2（root/group chain）・Phase 3（stack chord）・Phase 4（expression: velocity / articulation）・和声 / ボイシング機能 ([`Epic #224`](https://github.com/signalcompose/orbitscore/issues/224))
- **comp**: ボイスリーディング機能 C1 / C2a ([`#269`](https://github.com/signalcompose/orbitscore/issues/269), [`#271`](https://github.com/signalcompose/orbitscore/issues/271), [`#273`](https://github.com/signalcompose/orbitscore/issues/273))
- **セッションログ (`.orbslog`)**: 評価の因果記録を書き出す writer 層 L1（既定 off・dormant） ([`#229`](https://github.com/signalcompose/orbitscore/issues/229))
- **LinkAudio**: DSL 構文・UGen 実装・sum バスへの合流・`.vsix` への `OrbitLinkAudio.scx` 同梱 ([`Epic #187`](https://github.com/signalcompose/orbitscore/issues/187))
- **DSL: launch quantize**（v1.1.1 で先行リリース済、詳細は [1.1.1] を参照）

### Fixed

- npm audit: 出荷 `.vsix` に含まれる production 依存の `ws`（high: memory disclosure / DoS）を解消

## [1.1.1] - 2026-05-09

ICMC 2026 Hamburg (5/10-16) 直前の patch リリース。v1.1.0 にバンドルされていた quantize 関連の不具合修正 ([`#212`](https://github.com/signalcompose/orbitscore/issues/212)) をカンファレンス期間の配布物として ship した。詳細は [`docs/archive/WORK_LOG_2026-05.md`](docs/archive/WORK_LOG_2026-05.md)（6.87 / 6.88 エントリ）を参照。

### Added

- **DSL: launch quantize** ([`#212`](https://github.com/signalcompose/orbitscore/issues/212))
  - `global.quantize("bar")` (default) で `LOOP()` の起動を次のグローバル小節境界まで待機
  - `seq.quantize(...)` で per-sequence override
  - 値: `"off"` | `"beat"` | `"bar"` | `"2bar"` | `"4bar"` | `"8bar"`
  - `RUN()` (one-shot) は常に即時 (quantize 影響なし)
- **VS Code: `quantize` 補完 / hover** を global / sequence 両方に追加

### Changed

- **LOOP 中の `play()` 差し替えを次サイクル待機に変更** ([`#212`](https://github.com/signalcompose/orbitscore/issues/212))
  - 従来は即時で再スケジュール (リズムが小節をまたいで崩れる)
  - 新挙動: 次の小節境界で新パターンが発火
  - `gain` / `pan` / `audio` / `chop` は従来通り即時で反映
  - `tempo` / `beat` / `length` は従来通り次サイクル待機
- **VS Code 補完から実装が削除済の `global.tick()` / `global.key()` を除外**
  - 構文ハイライト (`orbitscore-audio.tmLanguage.json`) からも除去
- **`fixpitch` の hover を「(planned, see #213)」表記に変更**

### Fixed

- LOOP 起動が即時で行われていたため、 走行中の他ループとの整列ができなかった問題 ([`#212`](https://github.com/signalcompose/orbitscore/issues/212))
- **CI**: v1.1.x リリースラインに Marketplace publish gate（`vars.PUBLISH_MARKETPLACE`）が backport されておらず、stable tag push が必ず partial failure していた問題 ([`#216`](https://github.com/signalcompose/orbitscore/issues/216))

## [1.1.0] - 2026-05-06

ICMC 2026 Hamburg 発表整備の stable リリース。 v1.1.0-rc1 / rc2 / rc3 を経て、 学習サイト群の公開、 .orbs 拡張子への切替、 診断機能の追加を最終スコープに取り込んで stable 化。

> **Note**: `package.json` 上のバージョンは v1.1.0-rc 系列の retarget 整理に伴い `1.1.2` から `1.1.0` に戻している。 これは git tag (`v1.1.0`) を canonical な version reference として扱う運用のため、 npm registry 等の外部利用には影響しない。 詳細は [`docs/development/WORK_LOG.md`](docs/development/WORK_LOG.md) 6.75 を参照。

### Breaking Changes

- **ファイル拡張子変更**: `.osc` → `.orbs` ([`af9b887`](https://github.com/signalcompose/orbitscore/commit/af9b887))
  - 既存 `.osc` ファイルを使用しているユーザーは手動でリネームが必要
  - VS Code 言語登録、 syntax 定義、 サンプルファイルすべて更新済
  - semver 上は major bump (2.0.0) に該当するが、 RC 連番との連続性と利用者影響範囲を考慮して minor (1.1.0) として release

### Added

- **VS Code Extension**: グローバル once-per-file ルール違反と `audioPath` 順序違反を検出する診断機能 ([`0666633`](https://github.com/signalcompose/orbitscore/commit/0666633))
- **学習サイト**: ユーザー向け学習サイト `sites/user/` を新規構築 (8 章) ([`65a11b8`](https://github.com/signalcompose/orbitscore/commit/65a11b8))
- **学習サイト**: 開発者向け学習サイト `sites/dev/` の本体 16 章を一括執筆 ([`671481f`](https://github.com/signalcompose/orbitscore/commit/671481f))
- **i18n**: user / dev 両サイトに日英バイリンガル scaffolding を導入 ([`378e585`](https://github.com/signalcompose/orbitscore/commit/378e585))
- **i18n**: dev サイト 18 章 / user サイト 8 章の英訳を追加 ([`136c4b6`](https://github.com/signalcompose/orbitscore/commit/136c4b6), [`d4e1850`](https://github.com/signalcompose/orbitscore/commit/d4e1850))
- **CI**: user / dev 両学習サイトを GitHub Pages に自動 deploy する workflow ([`36dae32`](https://github.com/signalcompose/orbitscore/commit/36dae32))
  - user → `https://signalcompose.github.io/orbitscore/`
  - dev → `https://signalcompose.github.io/orbitscore/dev/`
- KaTeX CSS / フォントを vendor 化してオフラインでも数式が読める状態に ([`6591391`](https://github.com/signalcompose/orbitscore/commit/6591391))

### Changed

- 診断ロジックを純粋関数に分離してテスト容易性を向上 ([`2c3d793`](https://github.com/signalcompose/orbitscore/commit/2c3d793))

### Fixed

- 環境依存の audio file path 解決を排除し、 異なる作業ディレクトリでも同じ挙動になるよう修正 ([`f972ddc`](https://github.com/signalcompose/orbitscore/commit/f972ddc))
- 英訳版 dev サイト spike 章の絶対パスに `/en/` prefix を補完 ([`b3bcbfa`](https://github.com/signalcompose/orbitscore/commit/b3bcbfa))

### Documentation

- dev サイトの SoT verbatim 違反、 用語集の事実誤認、 DDD の曖昧さを修正
- ローカル / オフライン閲覧手順を README に追記
- README に学習サイト (web) セクションを追加

[Unreleased]: https://github.com/signalcompose/orbitscore/compare/v4.2.1...HEAD
[4.2.1]: https://github.com/signalcompose/orbitscore/compare/v4.2.0...v4.2.1
[4.2.0]: https://github.com/signalcompose/orbitscore/compare/v4.1.0...v4.2.0
[4.1.0]: https://github.com/signalcompose/orbitscore/compare/v4.0.1...v4.1.0
[4.0.1]: https://github.com/signalcompose/orbitscore/compare/v4.0.0...v4.0.1
[4.0.0]: https://github.com/signalcompose/orbitscore/compare/v3.0.0...v4.0.0
[3.0.0]: https://github.com/signalcompose/orbitscore/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/signalcompose/orbitscore/compare/v1.1.1...v2.0.0
[1.1.1]: https://github.com/signalcompose/orbitscore/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/signalcompose/orbitscore/releases/tag/v1.1.0
