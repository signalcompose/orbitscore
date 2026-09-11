//! orbit-link-audio の C++ shim(Ableton Link・GPL)をビルドする build script。
//!
//! 🔴 **Link のヘッダはこのリポジトリに入っていない(#502・2026-09-10)。**
//! 以前は `packages/sc-link-audio/external_libraries/link` (tag Link-4.0) の submodule を
//! SC plugin と共有していたが、SC バックエンドの削除で `packages/sc-link-audio` ごと
//! **submodule 登録を消した**。したがって `ORBIT_LINK_DIR` で Link の checkout を
//! 指すのが**唯一の経路**になる。
//!
//! ```sh
//! git clone --recursive https://github.com/Ableton/link.git /path/to/link   # tag Link-4.0
//! ORBIT_LINK_DIR=/path/to/link cargo build -p orbit-audio-daemon --features link-audio
//! ```
//!
//! ⚠️ **この crate を今後どう扱うかは未裁定**(#845)。`link-audio` feature は default off で
//! 出荷ビルドには入らない(Ableton Link は GPL-2.0-or-later / commercial の dual license で、
//! 有効化すると GPL が出荷バイナリの依存グラフに入る)。既存の checkout には submodule の
//! 作業ディレクトリが残っているため**手元では成功してしまう** — 緑は証拠にならない。
//!
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
    // Link ヘッダの場所。#502 で submodule 登録が消えたので **ORBIT_LINK_DIR が正規の経路**。
    // 既定値は旧 submodule のパスのまま残す — 既存の checkout（submodule の作業ディレクトリが
    // 残っている木）でそのままビルドできる互換のため。新規クローンでは存在しないので、
    // 下の panic が ORBIT_LINK_DIR を案内する。
    let link = env::var("ORBIT_LINK_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            manifest.join("../../../packages/sc-link-audio/external_libraries/link")
        });
    let header = link.join("include/ableton/LinkAudio.hpp");
    if !header.exists() {
        panic!(
            "Ableton Link のヘッダが見つかりません: {}\n\
             #502 (2026-09-10) で Link submodule の登録を削除しました。\
             `git submodule update --init ...` はもう使えません。\n\
             Link (tag Link-4.0) を別途 clone し、ORBIT_LINK_DIR でその root を指してください:\n\
             \x20 git clone --recursive https://github.com/Ableton/link.git /path/to/link\n\
             \x20 ORBIT_LINK_DIR=/path/to/link cargo build -p orbit-audio-daemon --features link-audio\n\
             この crate の扱い自体が未裁定です (#845)。",
            header.display()
        );
    }
    // Link は asio-standalone(submodule の nested submodule)を include する。
    // link だけ init して asio が未取得だと不親切なコンパイルエラーになるため明示チェック。
    let asio = link.join("modules/asio-standalone/asio/include");
    if !asio.exists() {
        panic!(
            "asio-standalone(Link の nested submodule)が見つかりません: {}\n\
             ORBIT_LINK_DIR が指す Link の checkout を `--recursive` で取得してください \
             (`git submodule update --init --recursive` をその checkout の中で実行)。",
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
