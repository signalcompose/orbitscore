//! プラグインカタログスキャナのコアロジック（#463 C1）。
//!
//! CLAP/VST3 バンドルを走査して `CatalogEntry` のリストを作り、
//! `~/.orbitscore/plugin-catalog.json` に atomic write する。
//!
//! 正本: docs/core/INSTRUCTION_ORBITSCORE_DSL.md「Plugin Catalog」節 PC.1

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// スキャン対象フォーマット。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Clap,
    Vst3,
}

/// カタログの role タグ（PC.1）。
pub const ROLE_INSTRUMENT: &str = "instrument";
pub const ROLE_EFFECT: &str = "effect";

/// カタログ 1 エントリ（PC.1 JSON スキーマ）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub name: String,
    pub vendor: String,
    pub format: Format,
    pub path: String,
    pub plugin_id: String,
    pub roles: Vec<String>,
}

/// トップレベルのカタログドキュメント（PC.1）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub version: u32,
    pub scanned_at: String,
    pub plugins: Vec<CatalogEntry>,
}

/// スキャン対象ディレクトリのデフォルト（PC.1）。
/// `~` は `dirs_home` で解決する（HOME 環境変数が読めない場合はスキップ）。
fn default_scan_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        dirs.push(home.join("Library/Audio/Plug-Ins/CLAP"));
        dirs.push(home.join("Library/Audio/Plug-Ins/VST3"));
    }
    dirs.push(PathBuf::from("/Library/Audio/Plug-Ins/CLAP"));
    dirs.push(PathBuf::from("/Library/Audio/Plug-Ins/VST3"));
    dirs
}

/// `ORBIT_PLUGIN_PATH`（`:` 区切り）を追加のスキャンディレクトリとして解釈する。
fn extra_scan_dirs_from_env(value: Option<&str>) -> Vec<PathBuf> {
    match value {
        None => Vec::new(),
        Some(raw) => raw
            .split(':')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect(),
    }
}

/// スキャンする全ディレクトリ（デフォルト + `ORBIT_PLUGIN_PATH`、重複除去）を返す。
pub fn resolve_scan_dirs(home: Option<&Path>, orbit_plugin_path: Option<&str>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut dirs = Vec::new();
    for dir in default_scan_dirs(home)
        .into_iter()
        .chain(extra_scan_dirs_from_env(orbit_plugin_path))
    {
        if seen.insert(dir.clone()) {
            dirs.push(dir);
        }
    }
    dirs
}

/// 1 ディレクトリ直下（非再帰）を走査し、`.clap` / `.vst3` バンドル候補を列挙する。
/// ディレクトリが存在しない・読めない場合は空 Vec を返す（stderr warn のみ）。
pub fn list_bundle_candidates(dir: &Path) -> Vec<(PathBuf, Format)> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            // 存在しないデフォルトパスは珍しくない（プラグイン未インストール環境）ので debug 相当。
            tracing::debug!("[orbit-plugin-scan] ディレクトリを読めません: {dir:?}: {error}");
            return Vec::new();
        }
    };

    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(extension) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        match extension.to_ascii_lowercase().as_str() {
            "clap" => found.push((path, Format::Clap)),
            "vst3" => found.push((path, Format::Vst3)),
            _ => {}
        }
    }
    found
}

/// 全スキャンディレクトリからバンドル候補を集める（非再帰・重複除去済みディレクトリのみ対象）。
pub fn collect_all_bundle_candidates(dirs: &[PathBuf]) -> Vec<(PathBuf, Format)> {
    dirs.iter()
        .flat_map(|dir| list_bundle_candidates(dir))
        .collect()
}

/// CLAP バンドル 1 つを走査してカタログエントリを作る。
/// ロード失敗時は空 Vec + stderr warn（全体を止めない・PC 仕様の「probe 失敗は skip」）。
pub fn scan_clap_bundle(path: &Path) -> Vec<CatalogEntry> {
    let found = match orbit_clap_host::list_plugins_in_file(path) {
        Ok(found) => found,
        Err(error) => {
            eprintln!("[orbit-plugin-scan] WARN: CLAP バンドルの走査に失敗: {path:?}: {error}");
            return Vec::new();
        }
    };

    found
        .into_iter()
        .map(|entry| {
            let roles = roles_from_clap_features(&entry.plugin.features);
            CatalogEntry {
                name: entry.plugin.name.unwrap_or_else(|| entry.plugin.id.clone()),
                vendor: entry.plugin.vendor.unwrap_or_default(),
                format: Format::Clap,
                path: path.to_string_lossy().into_owned(),
                plugin_id: entry.plugin.id,
                roles,
            }
        })
        .collect()
}

/// CLAP feature タグから role (instrument/effect) を判定する。
/// 両方一致・どちらも不一致の場合は両方入れる（安全側・PC.1 の role フィルタで絞り込む前提）。
fn roles_from_clap_features(features: &[String]) -> Vec<String> {
    let has_instrument = features.iter().any(|f| f == "instrument");
    let has_effect = features
        .iter()
        .any(|f| f == "audio-effect" || f == "audio_effect");

    match (has_instrument, has_effect) {
        (true, false) => vec![ROLE_INSTRUMENT.to_owned()],
        (false, true) => vec![ROLE_EFFECT.to_owned()],
        _ => vec![ROLE_INSTRUMENT.to_owned(), ROLE_EFFECT.to_owned()],
    }
}

/// VST3 バンドル 1 つを走査してカタログエントリを作る。
///
/// **`Contents/Resources/moduleinfo.json` がある場合のみ**エントリ化する（load 不要）。
/// 無い場合は probe（実ロード）せずに skip する — コンテンツ依存プラグイン（例: FIN-BOOST）が
/// ロード中にネイティブダイアログ（"Plugin content not found — navigate to .blob"）を出すことが
/// 実機確認され、無人スキャンで UI が出る/ブロックするのは受け入れ不可と判断されたため（owner
/// 実害報告・#463）。「UI 抑止付き probe」は C1b 以降で別途検討する。
pub fn scan_vst3_bundle(path: &Path) -> VstScanResult {
    let moduleinfo_path = path.join("Contents/Resources/moduleinfo.json");
    if !moduleinfo_path.is_file() {
        eprintln!("[orbit-plugin-scan] WARN: moduleinfo.json が無いため probe せず skip: {path:?}");
        return VstScanResult::Skipped;
    }

    match fs::read_to_string(&moduleinfo_path) {
        Ok(text) => match parse_moduleinfo(&text, path) {
            Ok(entries) if !entries.is_empty() => VstScanResult::Entries(entries),
            Ok(_) => {
                eprintln!(
                    "[orbit-plugin-scan] WARN: moduleinfo.json に Audio Module Class が無い、skip: {moduleinfo_path:?}"
                );
                VstScanResult::Skipped
            }
            Err(error) => {
                eprintln!(
                    "[orbit-plugin-scan] WARN: moduleinfo.json の parse に失敗、skip: {moduleinfo_path:?}: {error}"
                );
                VstScanResult::Skipped
            }
        },
        Err(error) => {
            eprintln!(
                "[orbit-plugin-scan] WARN: moduleinfo.json を読めません、skip: {moduleinfo_path:?}: {error}"
            );
            VstScanResult::Skipped
        }
    }
}

/// [`scan_vst3_bundle`] の結果。moduleinfo.json 不在/不正は probe にフォールバックせず
/// `Skipped` として明示的に扱う（呼び出し側が `skipped` リストへ集約できるように）。
pub enum VstScanResult {
    Entries(Vec<CatalogEntry>),
    Skipped,
}

/// Steinberg moduleinfo.json（trailing comma を含む非-strict JSON）を parse する。
/// `Category == "Audio Module Class"` のクラスのみカタログエントリ化する（Controller /
/// Compatibility クラスはロード可能な実体を持たないため除外）。
fn parse_moduleinfo(text: &str, bundle_path: &Path) -> Result<Vec<CatalogEntry>, String> {
    let sanitized = strip_trailing_commas(text);
    let doc: ModuleInfoDoc = serde_json::from_str(&sanitized).map_err(|error| error.to_string())?;

    let top_vendor = doc
        .factory_info
        .as_ref()
        .and_then(|f| f.vendor.clone())
        .unwrap_or_default();

    let entries = doc
        .classes
        .into_iter()
        .filter(|class| class.category.as_deref() == Some("Audio Module Class"))
        .filter_map(|class| {
            let cid = class.cid?;
            let name = class.name.unwrap_or_else(|| doc.name.clone());
            let vendor = class.vendor.unwrap_or_else(|| top_vendor.clone());
            let roles = roles_from_vst3_subcategories(&class.sub_categories);
            Some(CatalogEntry {
                name,
                vendor,
                format: Format::Vst3,
                path: bundle_path.to_string_lossy().into_owned(),
                plugin_id: cid,
                roles,
            })
        })
        .collect();
    Ok(entries)
}

/// VST3 moduleinfo.json の `Sub Categories` から role を判定する。
/// Instrument/Synth/Generator を instrument、それ以外（Fx 等）を effect とみなす。
/// どちらのヒントも無ければ安全側で両方入れる。
fn roles_from_vst3_subcategories(sub_categories: &[String]) -> Vec<String> {
    const INSTRUMENT_HINTS: [&str; 3] = ["Instrument", "Synth", "Generator"];
    let has_instrument = sub_categories
        .iter()
        .any(|s| INSTRUMENT_HINTS.contains(&s.as_str()));
    let has_other = sub_categories
        .iter()
        .any(|s| !INSTRUMENT_HINTS.contains(&s.as_str()));

    match (has_instrument, has_other) {
        (true, false) => vec![ROLE_INSTRUMENT.to_owned()],
        (false, true) => vec![ROLE_EFFECT.to_owned()],
        (true, true) => vec![ROLE_INSTRUMENT.to_owned(), ROLE_EFFECT.to_owned()],
        (false, false) => vec![ROLE_INSTRUMENT.to_owned(), ROLE_EFFECT.to_owned()],
    }
}

/// JSON 文字列中の trailing comma（`,` の直後に `}` または `]` が続くもの、空白/改行を挟んでもよい）
/// を取り除く。Steinberg の moduleinfo.json は仕様上 strict JSON ではなくこれを含むため必要。
/// 文字列リテラル内のカンマは変更しない。
fn strip_trailing_commas(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            output.push(ch);
            continue;
        }

        if ch == ',' {
            // 後続の空白/改行を先読みし、その次が `}` か `]` なら、このカンマを落とす。
            let mut lookahead = String::new();
            let mut temp_chars = chars.clone();
            let mut is_trailing = false;
            for next in temp_chars.by_ref() {
                if next.is_whitespace() {
                    lookahead.push(next);
                    continue;
                }
                is_trailing = next == '}' || next == ']';
                break;
            }
            if is_trailing {
                // カンマを出力せず、空白はそのまま消費して進める。
                for _ in 0..lookahead.chars().count() {
                    chars.next();
                }
                continue;
            }
        }

        output.push(ch);
    }

    output
}

#[derive(Debug, serde::Deserialize)]
struct ModuleInfoDoc {
    #[serde(rename = "Name", default)]
    name: String,
    #[serde(rename = "Factory Info", default)]
    factory_info: Option<FactoryInfo>,
    #[serde(rename = "Classes", default)]
    classes: Vec<ModuleClass>,
}

#[derive(Debug, serde::Deserialize)]
struct FactoryInfo {
    #[serde(rename = "Vendor", default)]
    vendor: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ModuleClass {
    #[serde(rename = "CID", default)]
    cid: Option<String>,
    #[serde(rename = "Category", default)]
    category: Option<String>,
    #[serde(rename = "Name", default)]
    name: Option<String>,
    #[serde(rename = "Vendor", default)]
    vendor: Option<String>,
    #[serde(rename = "Sub Categories", default)]
    sub_categories: Vec<String>,
}

/// dedup キー: (format, path, pluginId)。多バージョン/同名は「スキャン順で後勝ち」（PC.5）。
fn dedup_key(entry: &CatalogEntry) -> (u8, String, String) {
    let format_tag = match entry.format {
        Format::Clap => 0,
        Format::Vst3 => 1,
    };
    (format_tag, entry.path.clone(), entry.plugin_id.clone())
}

/// エントリ列を dedup する（後勝ち: 同キーの後続要素が前の要素を置き換える）。
pub fn dedup_entries(entries: Vec<CatalogEntry>) -> Vec<CatalogEntry> {
    let mut order: Vec<(u8, String, String)> = Vec::new();
    let mut map: std::collections::HashMap<(u8, String, String), CatalogEntry> =
        std::collections::HashMap::new();

    for entry in entries {
        let key = dedup_key(&entry);
        if !map.contains_key(&key) {
            order.push(key.clone());
        }
        map.insert(key, entry);
    }

    order
        .into_iter()
        .map(|key| map.remove(&key).expect("key was just inserted"))
        .collect()
}

/// 全ディレクトリを走査した結果: dedup 済みカタログエントリと、probe せず skip した VST3
/// バンドルのパス一覧（moduleinfo.json 不在/不正）。
pub struct ScanOutcome {
    pub entries: Vec<CatalogEntry>,
    pub skipped: Vec<String>,
}

/// 全ディレクトリを走査し、dedup 済みカタログエントリと skip リストを返す。
pub fn scan_all(dirs: &[PathBuf]) -> ScanOutcome {
    let candidates = collect_all_bundle_candidates(dirs);
    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    for (path, format) in candidates {
        match format {
            Format::Clap => entries.append(&mut scan_clap_bundle(&path)),
            Format::Vst3 => match scan_vst3_bundle(&path) {
                VstScanResult::Entries(mut found) => entries.append(&mut found),
                VstScanResult::Skipped => skipped.push(path.to_string_lossy().into_owned()),
            },
        }
    }
    ScanOutcome {
        entries: dedup_entries(entries),
        skipped,
    }
}

/// `~/.orbitscore/plugin-catalog.json` のパスを返す。
pub fn cache_path(home: &Path) -> PathBuf {
    home.join(".orbitscore").join("plugin-catalog.json")
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

fn format_unix_timestamp(total_seconds: u64) -> String {
    let days = total_seconds / 86_400;
    let rem = total_seconds % 86_400;
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;

    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard Hinnant の `civil_from_days` アルゴリズム（proleptic Gregorian, days since epoch 1970-01-01）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_scan_dirs_from_env_splits_on_colon() {
        let dirs = extra_scan_dirs_from_env(Some("/a/b:/c/d: :"));
        assert_eq!(dirs, vec![PathBuf::from("/a/b"), PathBuf::from("/c/d")]);
    }

    #[test]
    fn extra_scan_dirs_from_env_none_is_empty() {
        assert!(extra_scan_dirs_from_env(None).is_empty());
    }

    #[test]
    fn resolve_scan_dirs_dedupes_and_includes_defaults() {
        let home = PathBuf::from("/Users/tester");
        let dirs = resolve_scan_dirs(
            Some(&home),
            Some("/Library/Audio/Plug-Ins/VST3:/extra/path"),
        );
        assert!(dirs.contains(&home.join("Library/Audio/Plug-Ins/CLAP")));
        assert!(dirs.contains(&home.join("Library/Audio/Plug-Ins/VST3")));
        assert!(dirs.contains(&PathBuf::from("/Library/Audio/Plug-Ins/CLAP")));
        assert!(dirs.contains(&PathBuf::from("/extra/path")));
        // 重複除去: /Library/Audio/Plug-Ins/VST3 はデフォルトにも env にも入っているが 1 回のみ。
        let vst3_count = dirs
            .iter()
            .filter(|d| *d == &PathBuf::from("/Library/Audio/Plug-Ins/VST3"))
            .count();
        assert_eq!(vst3_count, 1);
    }

    #[test]
    fn list_bundle_candidates_is_non_recursive_and_filters_extensions() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path();

        fs::create_dir(root.join("Foo.clap")).unwrap();
        fs::create_dir(root.join("Bar.vst3")).unwrap();
        fs::write(root.join("ignore.txt"), "").unwrap();
        // 非再帰: サブディレクトリ内の .clap は見つからない。
        let nested = root.join("Foo.clap").join("Nested.clap");
        fs::create_dir(&nested).unwrap();

        let mut found = list_bundle_candidates(root);
        found.sort_by(|a, b| a.0.cmp(&b.0));

        assert_eq!(found.len(), 2);
        assert_eq!(found[0].1, Format::Vst3);
        assert_eq!(found[1].1, Format::Clap);
    }

    #[test]
    fn list_bundle_candidates_on_missing_dir_is_empty() {
        let found = list_bundle_candidates(Path::new("/does/not/exist/orbit-plugin-scan-test"));
        assert!(found.is_empty());
    }

    #[test]
    fn catalog_entry_serializes_expected_json_shape() {
        let entry = CatalogEntry {
            name: "Test Synth".to_owned(),
            vendor: "Acme".to_owned(),
            format: Format::Clap,
            path: "/path/to/Test.clap".to_owned(),
            plugin_id: "com.acme.testsynth".to_owned(),
            roles: vec![ROLE_INSTRUMENT.to_owned()],
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["name"], "Test Synth");
        assert_eq!(json["vendor"], "Acme");
        assert_eq!(json["format"], "clap");
        assert_eq!(json["path"], "/path/to/Test.clap");
        assert_eq!(json["pluginId"], "com.acme.testsynth");
        assert_eq!(json["roles"][0], "instrument");
    }

    #[test]
    fn catalog_serializes_top_level_shape() {
        let catalog = Catalog {
            version: 1,
            scanned_at: "2026-07-17T00:00:00Z".to_owned(),
            plugins: vec![],
        };
        let json = serde_json::to_value(&catalog).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["scannedAt"], "2026-07-17T00:00:00Z");
        assert!(json["plugins"].as_array().unwrap().is_empty());
    }

    #[test]
    fn dedup_entries_keeps_last_write_wins() {
        let make = |vendor: &str| CatalogEntry {
            name: "Same".to_owned(),
            vendor: vendor.to_owned(),
            format: Format::Vst3,
            path: "/p/Same.vst3".to_owned(),
            plugin_id: "CID123".to_owned(),
            roles: vec![ROLE_EFFECT.to_owned()],
        };
        let entries = vec![make("Old"), make("New")];
        let deduped = dedup_entries(entries);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].vendor, "New");
    }

    #[test]
    fn dedup_entries_preserves_distinct_keys() {
        let a = CatalogEntry {
            name: "A".to_owned(),
            vendor: String::new(),
            format: Format::Clap,
            path: "/p/A.clap".to_owned(),
            plugin_id: "id.a".to_owned(),
            roles: vec![],
        };
        let b = CatalogEntry {
            path: "/p/B.clap".to_owned(),
            plugin_id: "id.b".to_owned(),
            name: "B".to_owned(),
            ..a.clone()
        };
        let deduped = dedup_entries(vec![a, b]);
        assert_eq!(deduped.len(), 2);
    }

    #[test]
    fn roles_from_clap_features_instrument_only() {
        let features = vec!["instrument".to_owned(), "stereo".to_owned()];
        assert_eq!(roles_from_clap_features(&features), vec![ROLE_INSTRUMENT]);
    }

    #[test]
    fn roles_from_clap_features_effect_only() {
        let features = vec!["audio-effect".to_owned()];
        assert_eq!(roles_from_clap_features(&features), vec![ROLE_EFFECT]);
    }

    #[test]
    fn roles_from_clap_features_unknown_gets_both() {
        let features = vec!["stereo".to_owned()];
        let roles = roles_from_clap_features(&features);
        assert_eq!(roles, vec![ROLE_INSTRUMENT, ROLE_EFFECT]);
    }

    #[test]
    fn strip_trailing_commas_removes_before_close_brace_and_bracket() {
        let input = "{\"a\":1,\"b\":[1,2,],}";
        let stripped = strip_trailing_commas(input);
        let value: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(value["a"], 1);
        assert_eq!(value["b"][1], 2);
    }

    #[test]
    fn strip_trailing_commas_preserves_commas_inside_strings() {
        let input = r#"{"a":"has, a comma,"}"#;
        let stripped = strip_trailing_commas(input);
        let value: serde_json::Value = serde_json::from_str(&stripped).unwrap();
        assert_eq!(value["a"], "has, a comma,");
    }

    #[test]
    fn parse_moduleinfo_extracts_audio_module_class_only() {
        let text = r#"{
  "Name": "Scaler 3",
  "Factory Info": { "Vendor": "Scaler Music" },
  "Classes": [
    {
      "CID": "ABCDEF019182FAEB53634D7353636C33",
      "Category": "Audio Module Class",
      "Name": "Scaler 3",
      "Vendor": "Scaler Music",
      "Sub Categories": ["Instrument"],
    },
    {
      "CID": "ABCDEF011234ABCD53634D7353636C33",
      "Category": "Component Controller Class",
      "Name": "Scaler 3",
      "Vendor": "Scaler Music",
      "Sub Categories": ["Instrument"],
    },
  ],
}"#;
        let entries = parse_moduleinfo(text, Path::new("/p/Scaler.vst3")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].plugin_id, "ABCDEF019182FAEB53634D7353636C33");
        assert_eq!(entries[0].vendor, "Scaler Music");
        assert_eq!(entries[0].roles, vec![ROLE_INSTRUMENT.to_owned()]);
    }

    #[test]
    fn parse_moduleinfo_fx_subcategory_maps_to_effect() {
        let text = r#"{
  "Name": "Some Fx",
  "Classes": [
    { "CID": "AAAA", "Category": "Audio Module Class", "Sub Categories": ["Fx", "Reverb"] },
  ],
}"#;
        let entries = parse_moduleinfo(text, Path::new("/p/Fx.vst3")).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].roles, vec![ROLE_EFFECT.to_owned()]);
    }

    #[test]
    fn scan_vst3_bundle_without_moduleinfo_is_skipped_not_probed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bundle = temp.path().join("NoModuleInfo.vst3");
        fs::create_dir_all(bundle.join("Contents/Resources")).unwrap();
        // moduleinfo.json を意図的に置かない。

        match scan_vst3_bundle(&bundle) {
            VstScanResult::Skipped => {}
            VstScanResult::Entries(entries) => {
                panic!("expected Skipped, got Entries({entries:?})")
            }
        }
    }

    #[test]
    fn scan_vst3_bundle_with_moduleinfo_returns_entries() {
        let temp = tempfile::tempdir().expect("tempdir");
        let bundle = temp.path().join("HasModuleInfo.vst3");
        let resources = bundle.join("Contents/Resources");
        fs::create_dir_all(&resources).unwrap();
        fs::write(
            resources.join("moduleinfo.json"),
            r#"{
  "Name": "Test",
  "Classes": [
    { "CID": "AAAA", "Category": "Audio Module Class", "Sub Categories": ["Fx"] },
  ],
}"#,
        )
        .unwrap();

        match scan_vst3_bundle(&bundle) {
            VstScanResult::Entries(entries) => {
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].plugin_id, "AAAA");
            }
            VstScanResult::Skipped => panic!("expected Entries, got Skipped"),
        }
    }

    #[test]
    fn now_iso8601_matches_expected_format() {
        let ts = now_iso8601();
        assert_eq!(ts.len(), 20);
        assert!(ts.ends_with('Z'));
        assert_eq!(ts.as_bytes()[4], b'-');
        assert_eq!(ts.as_bytes()[10], b'T');
    }

    #[test]
    fn format_unix_timestamp_known_epoch() {
        // 2024-01-01T00:00:00Z = 1704067200
        assert_eq!(format_unix_timestamp(1_704_067_200), "2024-01-01T00:00:00Z");
        // Unix epoch itself.
        assert_eq!(format_unix_timestamp(0), "1970-01-01T00:00:00Z");
    }
}
