//! CLAP `CLAP_EXT_STATE` の吸い上げ / 適用（instrument・effect 共通）。
//!
//! instrument と effect は `PluginInstance<OrbitClapHost>` を同じ形で保持しており、
//! state の扱いに**フォーマット以外の差は無い**。それぞれのプロセッサに手書きすると、
//! 「拡張が無い時のエラー」「空 state を成功にしない」といった契約が2箇所で独立に
//! 漂流する。VST3 側は同じ理由で `capture_component_state` を自由関数に切り出しており、
//! ここはその対称形。

use clack_extensions::state::PluginState;
use clack_host::prelude::PluginInstance;

use crate::controller::ClapHostError;
use crate::host::OrbitClapHost;

/// プラグインが空の state を返した時のエラー文言。
///
/// **テストが文言に結合しないよう定数にしている**。テスト側がリテラルを書き写すと、
/// 実装の正しさではなく**文言の一致**を検査することになり、メッセージを整理しただけで
/// 無関係に red になる（レビュー指摘）。定数を共有すれば「この分岐が発火した」ことだけを
/// 検査できる。
pub const EMPTY_STATE_FROM_PLUGIN: &str =
    "plugin が空の state を返した（0 バイトを成功として登記しない）";

/// ホストしているプラグインの state を吸い上げる。
///
/// - 拡張が無い / `save` が失敗したら `Err`。**`Ok(vec![])` にしない**
/// - **空 state も `Err`**。サイズ 0 を「成功」として登記すると、再起動時に音色を
///   失ったことに気づけない（spec UIH.3「サイズ 0 の state を成功として登記しない」）
///
/// メインスレッドから呼ぶこと（`PluginMainThreadHandle` の契約）。本 crate の
/// プロセッサは `!Send` で単一スレッド運用なので、呼び出し側が守れば自然に満たされる。
pub fn capture_state(
    instance: &mut PluginInstance<OrbitClapHost>,
) -> Result<Vec<u8>, ClapHostError> {
    let mut handle = instance.plugin_handle();
    let state = handle
        .get_extension::<PluginState>()
        .ok_or_else(|| ClapHostError::State("plugin が CLAP_EXT_STATE を持たない".into()))?;
    let mut bytes = Vec::new();
    state
        .save(&mut handle, &mut bytes)
        .map_err(|error| ClapHostError::State(format!("save: {error}")))?;
    if bytes.is_empty() {
        return Err(ClapHostError::State(EMPTY_STATE_FROM_PLUGIN.into()));
    }
    Ok(bytes)
}

/// 保存済み state を適用する（#557・spawn 時の復元経路）。
///
/// VST3 側 `apply_state_bytes` と対称。**空バイト列は受け付けない** —
/// 「復元したつもりで既定音色のまま」という silent な取り違えを防ぐ。
///
/// ⚠️ **VST3 と非対称な一点**: VST3 は「setup 済み・inactive の component へ setState」が
/// 正準だが、**CLAP は `clap/ext/state.h` が `[main-thread]` としか規定しておらず**、
/// activate / processing 状態の制約が無い。本実装は `instantiate_activate` の後
/// （activate + start_processing 済み）に適用する。規格上は適法だが、
/// **activate 後の `load` に無反応な実プラグインが存在しないことは検証できていない**
/// （自前 oracle でしか踏んでいない）。サードパーティ CLAP での確認は残課題。
pub fn apply_state_bytes(
    instance: &mut PluginInstance<OrbitClapHost>,
    bytes: &[u8],
) -> Result<(), ClapHostError> {
    if bytes.is_empty() {
        return Err(ClapHostError::State("空の state を適用しようとした".into()));
    }
    let mut handle = instance.plugin_handle();
    let state = handle
        .get_extension::<PluginState>()
        .ok_or_else(|| ClapHostError::State("plugin が CLAP_EXT_STATE を持たない".into()))?;
    let mut reader = bytes;
    state
        .load(&mut handle, &mut reader)
        .map_err(|error| ClapHostError::State(format!("load: {error}")))
}
