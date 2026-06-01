# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [1.1.0] - 2026-05-06

ICMC 2026 Hamburg 発表整備の stable リリース。 v1.1.0-rc1 / rc2 / rc3 を経て、 学習サイト群の公開、 .orbs 拡張子への切替、 診断機能の追加を最終スコープに取り込んで stable 化。

> **Note**: `package.json` 上のバージョンは v1.1.0-rc 系列の retarget 整理に伴い `1.1.2` から `1.1.0` に戻している。 これは git tag (`v1.1.0`) を canonical な version reference として扱う運用のため、 npm registry 等の外部利用には影響しない。 詳細は [`docs/development/WORK_LOG.html`](docs/development/WORK_LOG.html) 6.75 を参照。

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

[Unreleased]: https://github.com/signalcompose/orbitscore/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/signalcompose/orbitscore/releases/tag/v1.1.0
