//! テストが使う「**殺されるまで生きる** stub child」の唯一の生成経路。
//!
//! 🔴 **テストが `Command::new("sleep").arg("30")` を直に書かないこと**（#622 / #629 レビュー）。
//!
//! #622 の欠陥は fixture の `exec sleep 20` が、それが生き残らねばならない経路の deadline
//! （`SETUP_DEADLINE` 30s / `CHILD_READY_TIMEOUT` 60s）より短かったこと。fixture 側だけ直しても、
//! **テストコードが直接固定秒数の child を spawn できる限り同じクラスは残る** — 実際 #629 の
//! 監査時点で `Command::new("sleep").arg("30")` が 7 箇所あり、fixture を走査する退行テストの
//! **検出圏外**だった。
//!
//! そこで「生きてさえいればよい stub」の作り方を**この 1 本に畳む**。ここを通れば秒数を書く
//! 場所が無く、`live-until-parent-exits.sh` の契約（親の消滅で終わる = deadline に潜らず
//! 孤児も残さない）を自動的に継承する。
//!
//! 検出器を賢くする方向（`perl -e 'sleep 20'` のような別の書き方まで正規表現で潰す）へは
//! 行かない。**書ける場所が 1 つなら検出は単純でよい。**

use std::path::PathBuf;
use std::process::Command;

/// 引数を無視して、殺されるまで（= 親の消滅まで）生き続ける child の実行ファイル。
pub(crate) fn stub_child_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("slow-child.sh")
}

/// 「殺されるまで生きる」stub child の `Command`。
///
/// **秒数を渡す口が無い**のがこの関数の存在理由。`sleep` を直に spawn する形に戻すと、
/// その数字は Rust 側の deadline と独立に腐る（#622）。
pub(crate) fn stub_child_command() -> Command {
    Command::new(stub_child_script())
}
