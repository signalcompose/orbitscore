## [1.2.0] - 2026-05-06

ICMC 2026 Hamburg 発表に向けた整備リリース。学習サイト群の公開、 .orbs 拡張子への切替、診断機能の追加を含む。

### Changed

- **拡張子変更**: ファイル拡張子を `.osc` から `.orbs` に変更 ([`af9b887`](https://github.com/signalcompose/orbitscore/commit/af9b887))
  - VS Code 言語登録、 syntax 定義、 サンプルファイルすべて更新
  - 既存 `.osc` ファイルは利用者側でリネームが必要
- 診断ロジックを純粋関数に分離してテスト容易性を向上 ([`2c3d793`](https://github.com/signalcompose/orbitscore/commit/2c3d793))

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

### Fixed

- 環境依存の audio file path 解決を排除し、 異なる作業ディレクトリでも同じ挙動になるよう修正 ([`f972ddc`](https://github.com/signalcompose/orbitscore/commit/f972ddc))
- 英訳版 dev サイト spike 章の絶対パスに `/en/` prefix を補完 ([`b3bcbfa`](https://github.com/signalcompose/orbitscore/commit/b3bcbfa))

### Documentation

- dev サイトの SoT verbatim 違反、 用語集の事実誤認、 DDD の曖昧さを修正
- ローカル / オフライン閲覧手順を README に追記
- README に学習サイト (web) セクションを追加

[1.2.0]: https://github.com/signalcompose/orbitscore/releases/tag/v1.2.0
