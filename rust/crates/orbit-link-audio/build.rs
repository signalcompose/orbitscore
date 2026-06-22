//! orbit-link-audio の C++ shim(Ableton Link・GPL)をビルドする build script。
//!
//! Link submodule は SC plugin と共有する:
//!   packages/sc-link-audio/external_libraries/link  (tag Link-4.0)
//! header-only のためライブラリのリンクは不要(include path + macOS frameworks のみ)。

use std::env;
use std::path::PathBuf;

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        panic!(
            "orbit-link-audio (LinkAudio egress) は現状 macOS 専用です \
             (target_os={target_os})。他 OS の LINK_PLATFORM 対応は follow-on。"
        );
    }

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    // Link submodule の場所。既定は monorepo 内で SC plugin と共有する submodule
    // (rust/crates/orbit-link-audio → リポジトリ root → packages/...)。別 checkout や
    // 再配置のため ORBIT_LINK_DIR で上書き可能。
    let link = env::var("ORBIT_LINK_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            manifest.join("../../../packages/sc-link-audio/external_libraries/link")
        });
    let header = link.join("include/ableton/LinkAudio.hpp");
    if !header.exists() {
        panic!(
            "Ableton Link submodule が見つかりません: {}\n\
             `git submodule update --init packages/sc-link-audio/external_libraries/link` \
             を実行してください。",
            header.display()
        );
    }
    // Link は asio-standalone(submodule の nested submodule)を include する。
    // link だけ init して asio が未取得だと不親切なコンパイルエラーになるため明示チェック。
    let asio = link.join("modules/asio-standalone/asio/include");
    if !asio.exists() {
        panic!(
            "asio-standalone(Link の nested submodule)が見つかりません: {}\n\
             `git submodule update --init --recursive packages/sc-link-audio/external_libraries/link` \
             を実行してください。",
            asio.display()
        );
    }

    cc::Build::new()
        .cpp(true)
        .std("c++17")
        // Link ヘッダ(third-party)のテンプレート instantiation 由来の警告は抑制する
        // (本 shim のコードに対する警告ではない)。
        .warnings(false)
        .define("LINK_PLATFORM_MACOSX", "1")
        .include(manifest.join("shim"))
        .include(link.join("include"))
        .include(link.join("modules/asio-standalone/asio/include"))
        .file(manifest.join("shim/orbit_link_shim.cpp"))
        .compile("orbit_link_shim");

    // Ableton Link が macOS で必要とする system frameworks。
    for framework in [
        "CoreFoundation",
        "CoreServices",
        "Security",
        "SystemConfiguration",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }

    println!("cargo:rerun-if-changed=shim/orbit_link_shim.cpp");
    println!("cargo:rerun-if-changed=shim/orbit_link_shim.hpp");
    // Link submodule(pin: Link-4.0)更新時に shim を再コンパイルさせる。
    println!(
        "cargo:rerun-if-changed={}",
        link.join("include/ableton").display()
    );
    println!("cargo:rerun-if-env-changed=ORBIT_LINK_DIR");
}
