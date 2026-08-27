//! daemon ⇄ rack child の **チェーン manifest / APPLY plan の唯一の型定義**（#628）。
//!
//! # なぜ共有モジュールにしたか
//!
//! 🔴 **同じ型を 2 箇所に書いたせいで、同じ serde 欠陥が 2 回出た。**
//!
//! #628 の初版は、daemon（`orbit-audio-daemon::outproc_effect`）と child
//! （`orbit-effect-rack-child`）が **フィールド名・型・serde 属性まで同一の型を独立に**
//! 持っていた。`enabled_by_default()` ヘルパーまで両方にコピーされていた。
//!
//! その結果、実機ゲートで **同一の欠陥が 2 段階に分かれて発覚**した:
//!
//! ```text
//! invalid ApplyEffectChain chain: unknown field `enabled`   ← daemon 側
//! parse …/apply.json: unknown field `kind` at line 1 col 302 ← child 側（daemon を直した直後）
//! ```
//!
//! **ユニットテストは両側とも緑だった** — 各々が自分の型を自分でテストしていたため。
//! wire を跨いだ実物だけが落ちていた。型が 1 つの真実源でない限り、この
//! 「片方だけ直して忘れる」は**フィールドを 1 つ足すたびに再発する**。
//!
//! # なぜこの crate か
//!
//! `orbit-audio-sandbox` は **daemon と child の両方が既に依存**しており、**clack-free**
//! （コードは memmap2 のみ使用）。本 PR は既に `transport.rs` の `CMD_APPLY_CHAIN` 等の
//! 定数をここに置いて両側から import する形にしてあり、**JSON の型だけがその原則から
//! 外れていた**。ここへ移すことで原則が揃う。
//!
//! daemon から child crate を直接依存させる案は採れない — child は
//! `[target.'cfg(target_os = "macos")'.dependencies]` で `orbit-clap-host` /
//! `orbit-vst3-host` を引き込むので、**daemon の clack-free 不変条件が壊れる**。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// `enabled` の既定値。省略は「有効」を意味する（SC.10.2 の単位元はあくまで明示指定）。
pub fn enabled_by_default() -> bool {
    true
}

/// ロード前の 1 stage。**format は `path` の拡張子から child が判定する** —
/// manifest に `format` フィールドは存在しない（CAP.6-1: 上位は形式分岐を持たない）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum StageSpec {
    /// カタログのプラグイン。実ファイルを指す。
    Catalog {
        path: PathBuf,
        #[serde(default)]
        plugin_id: Option<String>,
        #[serde(default)]
        state: Option<PathBuf>,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
    /// 標準プラグイン。**記号で運び、実パス解決は child が自分の exe の隣で行う**
    /// （インストールレイアウトの知識を daemon / TS に置かない・SC.10.8 規範 2）。
    Standard {
        name: String,
        #[serde(default)]
        params: BTreeMap<String, f64>,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
    /// 並列ブランチ。**v1 は予約のみ**で、child は BAD_ARG で拒否する（SC.10.11）。
    Layer { branches: serde_json::Value },
}

impl StageSpec {
    /// この stage が有効か。**`Layer` は v1 では常に無効**（適用は BAD_ARG で拒否される）。
    pub fn enabled(&self) -> bool {
        match self {
            Self::Catalog { enabled, .. } | Self::Standard { enabled, .. } => *enabled,
            Self::Layer { .. } => false,
        }
    }

    /// パラメータ。**standard 要素だけが持つ**（カタログのパラメータは #522 のスコープ）。
    pub fn params(&self) -> &BTreeMap<String, f64> {
        static EMPTY: std::sync::LazyLock<BTreeMap<String, f64>> =
            std::sync::LazyLock::new(BTreeMap::new);
        match self {
            Self::Standard { params, .. } => params,
            _ => &EMPTY,
        }
    }
}

/// spawn 時に渡すチェーン manifest（`--chain <path>`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChainManifest {
    pub version: u32,
    pub stages: Vec<StageSpec>,
}

/// APPLY plan の 1 要素。
///
/// 🔴 **`deny_unknown_fields` を付けてはいけない。** `Load` は `#[serde(flatten)]` で
/// `StageSpec` を展開するが、**serde は flatten と `deny_unknown_fields` の併用を支持しない**
/// — 外側の deserializer は内側のフィールド名を知らないため、`kind` / `path` / `enabled` が
/// 軒並み「unknown field」になる。**これがモジュール冒頭の 2 回の欠陥の正体**。
///
/// 厳密さは失っていない: `Keep` は自分のフィールドを列挙しており、`Load` の中身は
/// [`StageSpec`] 自身の `deny_unknown_fields` が検査する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum PlanStage {
    /// 旧チェーンの要素をそのまま生かす。`prev_index` は**適用前**チェーンの index なので
    /// シフトの曖昧さが無い。`params` は standard 要素のパラメータ更新にのみ有効。
    Keep {
        prev_index: usize,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
        #[serde(default)]
        params: BTreeMap<String, f64>,
    },
    /// 新規ロード。
    Load {
        #[serde(flatten)]
        stage: StageSpec,
    },
}

/// drop される要素の state 保存先。**standard 要素はここに現れない**（state を持たない）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SaveDropped {
    pub prev_index: usize,
    pub path: PathBuf,
}

/// `CMD_APPLY_CHAIN` が運ぶ plan（`<shm>.apply.json`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ApplyPlan {
    pub version: u32,
    pub stages: Vec<PlanStage>,
    #[serde(default)]
    pub save_dropped: Vec<SaveDropped>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 wire を実際に流れる JSON をそのまま受理できること。
    ///
    /// **型を 1 箇所にしたので、このテストも 1 箇所で足りる** — 以前は daemon 側と child 側で
    /// ほぼ同じテストを 2 本書いていた（そして両方緑のまま実機だけが落ちた）。
    #[test]
    fn apply_plan_accepts_the_payload_that_crosses_the_wire() {
        let json = r#"{
            "version": 1,
            "stages": [
                {"op":"load","kind":"catalog","path":"/x/CLAPTestEffect.clap","enabled":true},
                {"op":"load","kind":"catalog","path":"/x/y.vst3","plugin_id":"com.x.y",
                 "state":"/s/a.state","enabled":false},
                {"op":"load","kind":"standard","name":"Gain","params":{"db":-20.0},"enabled":true},
                {"op":"keep","prev_index":0,"enabled":true,"params":{"db":-6.0}}
            ],
            "save_dropped": [{"prev_index":1,"path":"/s/b.state"}]
        }"#;
        let plan: ApplyPlan = serde_json::from_str(json).expect("wire 上の plan は受理される");
        assert_eq!(plan.stages.len(), 4);
        assert_eq!(plan.save_dropped.len(), 1);

        // `enabled` / `state` / `params` が既定値へ落ちず、送られた値のまま届くこと。
        // 落ちると「バイパスしたのに音が鳴る」「音色が復元されない」という無言の故障になる。
        match &plan.stages[1] {
            PlanStage::Load {
                stage: StageSpec::Catalog { enabled, state, .. },
            } => {
                assert!(!enabled, "enabled:false が既定 true に落ちてはいけない");
                assert!(state.is_some(), "state が落ちてはいけない");
            }
            other => panic!("index 1 は catalog load のはず: {other:?}"),
        }
        match &plan.stages[2] {
            PlanStage::Load {
                stage: StageSpec::Standard { name, params, .. },
            } => {
                assert_eq!(name, "Gain");
                assert_eq!(params.get("db"), Some(&-20.0), "params が落ちてはいけない");
            }
            other => panic!("index 2 は standard load のはず: {other:?}"),
        }
    }

    /// 内側（[`StageSpec`]）の `deny_unknown_fields` は生きていること。
    /// 外側から外したのは flatten の制約が理由であって、**検査を緩めたのではない**。
    #[test]
    fn unknown_fields_inside_a_stage_are_still_rejected() {
        let json = r#"{"version":1,"stages":[{"op":"load","kind":"catalog","path":"/x/y.clap",
                      "enabled":true,"bogus":1}],"save_dropped":[]}"#;
        assert!(
            serde_json::from_str::<ApplyPlan>(json).is_err(),
            "stage の中の未知フィールドは従来どおり拒否されなければならない"
        );
    }

    /// 🔴 **round-trip**: daemon が書いた JSON を child が読める。
    /// 型が 1 つなので構造的に保証されるが、serde 属性の事故（`rename` の付け忘れ等）は
    /// 依然あり得るので実際に往復させる。
    #[test]
    fn a_plan_serialized_here_deserializes_here() {
        let plan = ApplyPlan {
            version: 1,
            stages: vec![
                PlanStage::Load {
                    stage: StageSpec::Standard {
                        name: "Gain".into(),
                        params: BTreeMap::from([("db".to_owned(), -6.0)]),
                        enabled: false,
                    },
                },
                PlanStage::Keep {
                    prev_index: 2,
                    enabled: true,
                    params: BTreeMap::new(),
                },
            ],
            save_dropped: vec![SaveDropped {
                prev_index: 0,
                path: PathBuf::from("/s/x.state"),
            }],
        };
        let json = serde_json::to_string(&plan).expect("serialize");
        let back: ApplyPlan = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(plan, back, "往復で内容が変わってはいけない");
    }
}
