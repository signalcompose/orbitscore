//! orbit-audio-daemon library crate.
//!
//! integration test と binary main のみがユーザー。通常利用では
//! [`crate::main`] 経由で bin として動かす前提。
//!
//! test 側は `tests/protocol.rs` から [`backend::StubBackend`] を
//! 経由して `EngineWrap` を audio device なしで起動する。

pub mod backend;
/// 🔴 #605/#612: 診断チャネル（stderr）の故障で daemon を殺さない書き込み。
pub mod best_effort_stderr;
/// in-process CLAP plugin hosting の daemon 配線。feature `clap-host`（default off）でのみ
/// コンパイルされ、`orbit-clap-host` の `ClapHost`(!Send) を専用スレッドで所有する（Issue #340）。
#[cfg(feature = "clap-host")]
pub mod clap_host;
pub mod engine_wrap;
/// 🔴 GPL 境界: LinkAudio egress の control-side 配線。feature `link-audio`（default off）でのみ
/// コンパイルされ、GPL crate `orbit-link-audio` を保持する consumer thread を起動する。
#[cfg(feature = "link-audio")]
pub mod link_audio;
/// attach する plugin の拡張子から child binary を選ぶ規則。**effect と instrument で共有する**
/// （規則を2箇所に持つと、片方だけ直し忘れる — #548 がまさにその形のバグだった）。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) mod outproc_child_exe;

/// f32 サンプル列の絶対ピークを IEEE754 bits で返す（符号ビットを落として比較可能にする）。
/// `AtomicU32::fetch_max` で published される peak 統計の共通実装。
///
/// 🔴 **どちらか一方の feature で有効になる位置に置くこと。** `outproc_effect` の中に置くと
/// **instrument 単独ビルドから参照できず壊れる**。逆に cfg を付けないと、**両方 off の
/// default build で呼び出し元が消えて dead_code になる**。この PR で両方踏んだ。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) fn peak_bits(data: &[f32]) -> u32 {
    data.iter()
        .map(|s| s.to_bits() & 0x7FFF_FFFF)
        .max()
        .unwrap_or(0)
}

/// child の early-exit の「事実」と「理由」を対で持つ型。**effect と instrument で共有する**
/// （2 つを別々に持つと片方だけ倒す/立てる余地が残る — #629 レビュー）。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) mod outproc_child_exit;
/// γ M1 PR-C: out-of-process effect の daemon 配線。feature `outproc-effect`（default off・clack-free）
/// でのみコンパイルされ、別プロセスの実 CLAP effect child へ共有メモリ transport 越しに audio を流す。
#[cfg(feature = "outproc-effect")]
pub mod outproc_effect;
/// Out-of-process CLAP instrument production integration（Issue #420・default off・clack-free）。
#[cfg(feature = "outproc-instrument")]
pub mod outproc_instrument;
/// watchdog の「起動直後に死に続ける child を tight loop で respawn し続ける」検知ロジック（#573）。
/// **effect と instrument で共有する**（規則を2箇所に持つと片方だけ直し忘れる — #548 と同種のリスク）。
#[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
pub(crate) mod outproc_respawn_guard;
/// テストが使う「殺されるまで生きる stub child」の唯一の生成経路（#622 / #629）。
/// テストコードが固定秒数の `sleep` を直に spawn できると、fixture 側だけ直しても同じクラスが残る。
#[cfg(all(test, any(feature = "outproc-effect", feature = "outproc-instrument")))]
pub(crate) mod outproc_stub_child;
pub mod protocol;
pub mod server;
pub mod session;

/// daemon が spawn しうる child 実行ファイル名の**唯一の一覧**。
///
/// 🔴 **新しい child を足したらここに 1 行足すこと。** 出荷ゲート
/// （`.github/workflows/release.yml` の post-package gate）と packaging スクリプト
/// （`scripts/copy-daemon-bin.sh`）はこの一覧と突き合わせて検査される
/// （`tests/vscode-extension/bundled-child-binaries.spec.ts`）。
///
/// # なぜ定数にしたか
///
/// 台帳テストはもともと **Rust ソースを正規表現で読んで**一覧を再構成していた。これは
/// **2 回続けて静かに取りこぼした**:
///
/// 1. 初版は `orbit-[a-z0-9-]+-child` と**綴りを決め打ち**していたため、child をリネームすると
///    抽出が縮んでテストが pass してしまった
/// 2. 次は `Self::Vst3 => "…"` という**分岐の形を決め打ち**していたため、format 分岐を持たない
///    初の child（#628 の rack child = 1 child が CLAP/VST3 両方を持つ）が漏れ、
///    **出荷ゲートと実装が食い違った**
///
/// どちらも「今ある形」に最適化した抽出規則が、新しい形で破れたもの。パターンを足して
/// かわす対処は**脆さを移動させるだけ**なので、**真実を 1 箇所に明示する**形へ変えた。
/// 新しい spawn 経路を足す開発者は、ここへの追記という明示的な行為を強制される。
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
