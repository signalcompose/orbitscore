//! attach する plugin の拡張子から out-of-process child binary を選ぶ規則（#552）。
//!
//! **effect と instrument で共有する。** 両者は「フォーマット別デフォルト名なら同ディレクトリで
//! 読み替え、そうでなければ明示指定として触らない」という同一の規則を持ち、違うのは
//! **binary 名の対だけ**。別々に持つと、規則を直したとき片方だけ直し忘れる形になる
//! （まさに #548 が「片方だけ入っていなかった」バグだった）。

use std::path::{Path, PathBuf};

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

/// ログ表示用に child binary の名前を取り出す。取れなければ `fallback`。
pub(crate) fn exe_label(exe: &Path, fallback: &str) -> String {
    exe.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(fallback)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAP: &str = "orbit-clap-effect-child";
    const VST3: &str = "orbit-vst3-effect-child";

    #[test]
    fn default_child_is_swapped_by_extension_within_the_same_directory() {
        let current = Path::new("/opt/orbit/bin").join(CLAP);
        assert_eq!(
            child_exe_for_attach(&current, Path::new("/plugins/Reverb.vst3"), CLAP, VST3),
            Path::new("/opt/orbit/bin").join(VST3),
            "同ディレクトリで読み替えていない"
        );
        // 逆向きも成立する（冪等・対称）。
        let vst3_current = Path::new("/opt/orbit/bin").join(VST3);
        assert_eq!(
            child_exe_for_attach(&vst3_current, Path::new("/plugins/Delay.clap"), CLAP, VST3),
            Path::new("/opt/orbit/bin").join(CLAP)
        );
    }

    #[test]
    fn an_explicitly_named_child_is_left_alone() {
        let explicit = Path::new("/custom/my-own-child");
        assert_eq!(
            child_exe_for_attach(explicit, Path::new("/plugins/Reverb.vst3"), CLAP, VST3),
            explicit,
            "明示指定の child を書き換えた（override が壊れる）"
        );
    }

    #[test]
    fn an_unknown_extension_falls_back_to_clap() {
        let current = Path::new("/opt/orbit/bin").join(VST3);
        assert_eq!(
            child_exe_for_attach(&current, Path::new("/plugins/raw.dylib"), CLAP, VST3),
            Path::new("/opt/orbit/bin").join(CLAP),
            "未知拡張子が CLAP へ落ちていない（raw .dylib の gated テストが壊れる）"
        );
    }

    #[test]
    fn vst3_detection_ignores_case_and_rejects_lookalikes() {
        assert!(is_vst3_plugin_path(Path::new("/p/A.VST3")));
        assert!(is_vst3_plugin_path(Path::new("/p/A.vst3")));
        assert!(!is_vst3_plugin_path(Path::new("/p/A.vst")));
        assert!(!is_vst3_plugin_path(Path::new("/p/vst3")), "拡張子ではない");
    }

    #[test]
    fn exe_label_falls_back_when_the_path_has_no_file_name() {
        assert_eq!(
            exe_label(Path::new("/opt/bin/child-x"), "fallback"),
            "child-x"
        );
        assert_eq!(exe_label(Path::new("/"), "fallback"), "fallback");
    }
}
