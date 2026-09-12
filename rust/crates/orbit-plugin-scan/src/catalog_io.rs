//! カタログの読み書きと ISO8601 タイムスタンプ（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

/// `~/.orbitscore/plugin-catalog.json` のパスを返す。
pub fn cache_path(home: &Path) -> PathBuf {
    home.join(".orbitscore").join("plugin-catalog.json")
}

/// Read a prior catalog for positive/negative cache lookup.
///
/// A missing file is the normal cold-start case. Malformed or unreadable files are reported to
/// the caller so the scanner can warn and safely continue with a cold scan.
pub fn read_catalog(path: &Path) -> io::Result<Option<Catalog>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

/// カタログを JSON にシリアライズして `path` へ atomic write（tmp + rename）する。
pub fn write_catalog(catalog: &Catalog, path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(catalog)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, path)?;
    Ok(())
}

/// 現在時刻を ISO8601 (UTC, `YYYY-MM-DDTHH:MM:SSZ`) にフォーマットする。
/// chrono 等の外部 crate を workspace に追加しないため自前実装（うるう秒は考慮しない）。
pub fn now_iso8601() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format_unix_timestamp(duration.as_secs())
}

pub(crate) fn format_unix_timestamp(total_seconds: u64) -> String {
    let days = total_seconds / 86_400;
    let rem = total_seconds % 86_400;
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;

    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard Hinnant の `civil_from_days` アルゴリズム（proleptic Gregorian, days since epoch 1970-01-01）。
pub(crate) fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
