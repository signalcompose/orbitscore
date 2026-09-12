//! Mach-O ヘッダの読み出しとバンドル実行ファイルの特定（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

pub(crate) const MAX_FAT_ARCHES: usize = 64;
pub(crate) const MAX_MACHO_HEADER_BYTES: u64 = (8 + MAX_FAT_ARCHES * 32) as u64;

#[derive(Clone, Copy)]
pub(crate) enum ByteOrder {
    Big,
    Little,
}

pub(crate) fn read_u32(bytes: &[u8], order: ByteOrder) -> u32 {
    let bytes: [u8; 4] = bytes.try_into().expect("caller supplies four bytes");
    match order {
        ByteOrder::Big => u32::from_be_bytes(bytes),
        ByteOrder::Little => u32::from_le_bytes(bytes),
    }
}

/// Read only the Mach-O header and architecture table; plugin executables can be gigabytes.
pub(crate) fn read_macho_architectures(path: &Path) -> io::Result<Option<Vec<String>>> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_MACHO_HEADER_BYTES)
        .read_to_end(&mut bytes)?;
    Ok(parse_macho_architectures(&bytes))
}

pub(crate) fn parse_macho_architectures(bytes: &[u8]) -> Option<Vec<String>> {
    let magic: [u8; 4] = bytes.get(..4)?.try_into().ok()?;
    let (order, fat_record_size) = match magic {
        // Thin 32/64-bit Mach-O headers. The CPU type follows the magic in both layouts.
        [0xfe, 0xed, 0xfa, 0xce] | [0xfe, 0xed, 0xfa, 0xcf] => (ByteOrder::Big, None),
        [0xce, 0xfa, 0xed, 0xfe] | [0xcf, 0xfa, 0xed, 0xfe] => (ByteOrder::Little, None),
        // FAT_MAGIC/FAT_CIGAM and FAT_MAGIC_64/FAT_CIGAM_64.
        [0xca, 0xfe, 0xba, 0xbe] => (ByteOrder::Big, Some(20)),
        [0xbe, 0xba, 0xfe, 0xca] => (ByteOrder::Little, Some(20)),
        [0xca, 0xfe, 0xba, 0xbf] => (ByteOrder::Big, Some(32)),
        [0xbf, 0xba, 0xfe, 0xca] => (ByteOrder::Little, Some(32)),
        _ => return None,
    };

    let second_word = bytes.get(4..8)?;
    let Some(record_size) = fat_record_size else {
        return Some(vec![macho_arch_name(read_u32(second_word, order))]);
    };
    let count = read_u32(second_word, order) as usize;
    if count == 0 || count > MAX_FAT_ARCHES || bytes.len() < 8 + count * record_size {
        return None;
    }

    let mut architectures = Vec::with_capacity(count);
    for record in bytes[8..].chunks_exact(record_size).take(count) {
        let architecture = macho_arch_name(read_u32(&record[..4], order));
        if !architectures.contains(&architecture) {
            architectures.push(architecture);
        }
    }
    Some(architectures)
}

pub(crate) fn macho_arch_name(cpu_type: u32) -> String {
    match cpu_type {
        7 => "x86".to_owned(),
        0x0100_0007 => "x86_64".to_owned(),
        12 => "arm".to_owned(),
        0x0100_000c => "arm64".to_owned(),
        0x0200_000c => "arm64_32".to_owned(),
        18 => "powerpc".to_owned(),
        0x0100_0012 => "powerpc64".to_owned(),
        _ => format!("unknown(0x{cpu_type:08x})"),
    }
}

pub(crate) fn host_macho_arch_name() -> Option<&'static str> {
    match std::env::consts::ARCH {
        "x86" => Some("x86"),
        "x86_64" => Some("x86_64"),
        "arm" => Some("arm"),
        "aarch64" => Some("arm64"),
        "powerpc" => Some("powerpc"),
        "powerpc64" => Some("powerpc64"),
        _ => None,
    }
}

pub(crate) fn fallback_bundle_executable(bundle_path: &Path) -> ResolvedExecutable {
    let executable_dir = bundle_path.join("Contents/MacOS");
    if let Some(name) = xml_bundle_executable_name(&bundle_path.join("Contents/Info.plist")) {
        return ResolvedExecutable {
            path: executable_dir.join(name),
            resolution: ExecutableResolution::InfoPlistXml,
        };
    }

    let bundle_stem = bundle_path.file_stem().unwrap_or_default();
    let conventional = executable_dir.join(bundle_stem);
    if conventional.is_file() {
        return ResolvedExecutable {
            path: conventional,
            resolution: ExecutableResolution::Convention,
        };
    }

    let mut files = fs::read_dir(&executable_dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    files.sort();
    match files.into_iter().next() {
        Some(path) => ResolvedExecutable {
            path,
            resolution: ExecutableResolution::DirectoryScan,
        },
        None => ResolvedExecutable {
            path: conventional,
            resolution: ExecutableResolution::Convention,
        },
    }
}

/// XML plists are common and this keeps non-macOS tests/builds independent of CoreFoundation.
/// Binary plists on macOS are resolved by `CFBundleCopyExecutableURL` before this fallback.
pub(crate) fn xml_bundle_executable_name(info_plist: &Path) -> Option<String> {
    let text = fs::read_to_string(info_plist).ok()?;
    let key_offset = text.find("<key>CFBundleExecutable</key>")?;
    let remainder = &text[key_offset + "<key>CFBundleExecutable</key>".len()..];
    let value_start = remainder.find("<string>")? + "<string>".len();
    let value_end = remainder[value_start..].find("</string>")? + value_start;
    let value = remainder[value_start..value_end].trim();
    (!value.is_empty()).then(|| value.to_owned())
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_bundle_executable(bundle_path: &Path) -> Option<PathBuf> {
    use core_foundation_sys::base::{kCFAllocatorDefault, CFRelease, CFTypeRef};
    use core_foundation_sys::bundle::{CFBundleCopyExecutableURL, CFBundleCreate};
    use core_foundation_sys::string::{kCFStringEncodingUTF8, CFStringCreateWithCString};
    use core_foundation_sys::url::{
        kCFURLPOSIXPathStyle, CFURLCreateWithFileSystemPath, CFURLGetFileSystemRepresentation,
    };
    use std::ffi::CString;
    use std::os::unix::ffi::OsStringExt;

    struct OwnedCf(CFTypeRef);
    impl Drop for OwnedCf {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: every stored reference is returned at +1 by a CoreFoundation Create or
                // Copy function and is released exactly once by this guard.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    let path = CString::new(bundle_path.as_os_str().as_encoded_bytes()).ok()?;
    // SAFETY: all CoreFoundation pointers are checked before use and owned Create/Copy results
    // are held by `OwnedCf` until this function returns.
    unsafe {
        let cf_path =
            CFStringCreateWithCString(kCFAllocatorDefault, path.as_ptr(), kCFStringEncodingUTF8);
        if cf_path.is_null() {
            return None;
        }
        let _cf_path_guard = OwnedCf(cf_path.cast());
        let bundle_url =
            CFURLCreateWithFileSystemPath(kCFAllocatorDefault, cf_path, kCFURLPOSIXPathStyle, 1);
        if bundle_url.is_null() {
            return None;
        }
        let _bundle_url_guard = OwnedCf(bundle_url.cast());
        let bundle = CFBundleCreate(kCFAllocatorDefault, bundle_url);
        if bundle.is_null() {
            return None;
        }
        let _bundle_guard = OwnedCf(bundle.cast());
        let executable_url = CFBundleCopyExecutableURL(bundle);
        if executable_url.is_null() {
            return None;
        }
        let _executable_url_guard = OwnedCf(executable_url.cast());

        // macOS PATH_MAX is 1024; leave ample room without depending on a libc constant.
        let mut bytes = vec![0_u8; 16 * 1024];
        if CFURLGetFileSystemRepresentation(
            executable_url,
            1,
            bytes.as_mut_ptr(),
            bytes.len() as isize,
        ) == 0
        {
            return None;
        }
        let length = bytes.iter().position(|byte| *byte == 0)?;
        bytes.truncate(length);
        Some(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
    }
}
