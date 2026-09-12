//! VST3 バンドルの走査（moduleinfo.json の解析と dedup）（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

/// VST3 バンドル 1 つを走査してカタログエントリを作る。
///
/// **`Contents/Resources/moduleinfo.json` がある場合のみ**エントリ化する（load 不要）。
/// 無い場合は probe（実ロード）せずに pending にする — コンテンツ依存プラグイン（例: FIN-BOOST）が
/// ロード中にネイティブダイアログ（"Plugin content not found — navigate to .blob"）を出すことが
/// 実機確認され、無人スキャンで UI が出る/ブロックするのは受け入れ不可と判断されたため（owner
/// 実害報告・#463）。native probe は explicit rescan からのみ子プロセスで実行する。
pub fn scan_vst3_bundle(path: &Path) -> VstScanResult {
    let moduleinfo_path = path.join("Contents/Resources/moduleinfo.json");
    if !moduleinfo_path.is_file() {
        return VstScanResult::ProbePending {
            reason: "moduleinfoMissing".to_owned(),
        };
    }

    match fs::read_to_string(&moduleinfo_path) {
        Ok(text) => match parse_moduleinfo(&text, path) {
            Ok(entries) if !entries.is_empty() => VstScanResult::StaticSuccess(entries),
            Ok(_) => {
                eprintln!(
                    "[orbit-plugin-scan] WARN: moduleinfo.json に Audio Module Class が無いため probe 待ち: {moduleinfo_path:?}"
                );
                VstScanResult::ProbePending {
                    reason: "moduleinfoNoAudioClasses".to_owned(),
                }
            }
            Err(error) => {
                eprintln!(
                    "[orbit-plugin-scan] WARN: moduleinfo.json の parse に失敗したため probe 待ち: {moduleinfo_path:?}: {error}"
                );
                VstScanResult::ProbePending {
                    reason: "moduleinfoInvalid".to_owned(),
                }
            }
        },
        Err(error) => {
            eprintln!(
                "[orbit-plugin-scan] WARN: moduleinfo.json を読めないため probe 待ち: {moduleinfo_path:?}: {error}"
            );
            VstScanResult::ProbePending {
                reason: "moduleinfoUnreadable".to_owned(),
            }
        }
    }
}

/// [`scan_vst3_bundle`] の metadata-only 結果。
#[derive(Debug)]
pub enum VstScanResult {
    StaticSuccess(Vec<CatalogEntry>),
    ProbePending { reason: String },
}

/// Steinberg moduleinfo.json（trailing comma を含む非-strict JSON）を parse する。
/// `Category == "Audio Module Class"` のクラスのみカタログエントリ化する（Controller /
/// Compatibility クラスはロード可能な実体を持たないため除外）。
pub(crate) fn parse_moduleinfo(
    text: &str,
    bundle_path: &Path,
) -> Result<Vec<CatalogEntry>, String> {
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
pub(crate) fn roles_from_vst3_subcategories(sub_categories: &[String]) -> Vec<String> {
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
pub(crate) fn strip_trailing_commas(input: &str) -> String {
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
pub(crate) struct ModuleInfoDoc {
    #[serde(rename = "Name", default)]
    pub(crate) name: String,
    #[serde(rename = "Factory Info", default)]
    pub(crate) factory_info: Option<FactoryInfo>,
    #[serde(rename = "Classes", default)]
    pub(crate) classes: Vec<ModuleClass>,
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct FactoryInfo {
    #[serde(rename = "Vendor", default)]
    pub(crate) vendor: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct ModuleClass {
    #[serde(rename = "CID", default)]
    pub(crate) cid: Option<String>,
    #[serde(rename = "Category", default)]
    pub(crate) category: Option<String>,
    #[serde(rename = "Name", default)]
    pub(crate) name: Option<String>,
    #[serde(rename = "Vendor", default)]
    pub(crate) vendor: Option<String>,
    #[serde(rename = "Sub Categories", default)]
    pub(crate) sub_categories: Vec<String>,
}

/// dedup キー: (format, path, pluginId)。多バージョン/同名は「スキャン順で後勝ち」（PC.5）。
pub(crate) fn dedup_key(entry: &CatalogEntry) -> (u8, String, String) {
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
