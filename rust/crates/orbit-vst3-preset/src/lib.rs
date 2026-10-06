//! VST3 `.vstpreset` container の解析（#540 P2）。
//!
//! `orbit-vst3-host` の `host/setup.rs` から移した（#982）。`orbit-vst3-host` は crate 全体が
//! macOS 専用で、CI（ubuntu）ではこの解析のテストが走らなかった。ファイル形式の扱いは
//! COM にも CoreFoundation にも依存しないので、全プラットフォームでビルドできる crate に置く。

use std::error::Error;
use std::fmt::{Display, Formatter};

/// `.vstpreset` container の chunk 参照（[`parse`] の結果）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VstPresetChunks<'a> {
    pub component: &'a [u8],
    pub controller: Option<&'a [u8]>,
}

/// magic は `VST3` なのに構造が壊れている container。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MalformedPreset(String);

impl Display for MalformedPreset {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "malformed .vstpreset: {}", self.0)
    }
}

impl Error for MalformedPreset {}

/// `.vstpreset` container を解析する（Steinberg "VST 3 Preset File Format"）。
///
/// レイアウト: header 48 bytes = magic `VST3`(4) + version i32 LE(4) + class ID ASCII(32) +
/// chunk-list offset i64 LE(8)。chunk list = magic `List`(4) + count i32 LE(4) +
/// count × { chunk ID(4) + offset i64 LE(8) + size i64 LE(8) }。`Comp` = component state・
/// `Cont` = controller state・`Info` はメタデータ（無視）。
///
/// 先頭 magic が `VST3` でなければ `Ok(None)`（呼び出し側は raw component state chunk として
/// 扱う）。magic が合うのに構造が壊れている場合はエラー（silent に raw 扱いすると
/// container ヘッダごと setState に流れて plugin 側で不可解に失敗する）。
///
/// header の class ID は照合しない: TUID ↔ ASCII 表現はプラットフォームで byte order が
/// 異なり（COM 互換 swap）、誤検知で正当な preset を弾くリスクが照合の利得を上回る。
/// 不一致の preset は plugin 自身の setState が拒否する。
pub fn parse(bytes: &[u8]) -> Result<Option<VstPresetChunks<'_>>, MalformedPreset> {
    if bytes.len() < 4 || &bytes[0..4] != b"VST3" {
        return Ok(None);
    }
    let malformed = |reason: &str| MalformedPreset(reason.to_string());
    if bytes.len() < 48 {
        return Err(malformed("header shorter than 48 bytes"));
    }
    let read_i64 = |offset: usize| -> Result<i64, MalformedPreset> {
        let end = offset
            .checked_add(8)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| malformed("integer field out of bounds"))?;
        Ok(i64::from_le_bytes(bytes[offset..end].try_into().unwrap()))
    };
    let list_offset =
        usize::try_from(read_i64(40)?).map_err(|_| malformed("negative chunk-list offset"))?;
    let list_end = list_offset
        .checked_add(8)
        .filter(|&end| end <= bytes.len())
        .ok_or_else(|| malformed("chunk-list offset out of bounds"))?;
    if &bytes[list_offset..list_offset + 4] != b"List" {
        return Err(malformed("chunk list magic is not 'List'"));
    }
    let count = i32::from_le_bytes(bytes[list_offset + 4..list_end].try_into().unwrap());
    let count = usize::try_from(count).map_err(|_| malformed("negative chunk count"))?;
    let mut component: Option<&[u8]> = None;
    let mut controller: Option<&[u8]> = None;
    for index in 0..count {
        let entry = list_end + index * 20;
        let entry_end = entry
            .checked_add(20)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| malformed("chunk entry out of bounds"))?;
        let id = &bytes[entry..entry + 4];
        let offset = usize::try_from(read_i64(entry + 4)?)
            .map_err(|_| malformed("negative chunk offset"))?;
        let size =
            usize::try_from(read_i64(entry + 12)?).map_err(|_| malformed("negative chunk size"))?;
        let end = offset
            .checked_add(size)
            .filter(|&end| end <= bytes.len())
            .ok_or_else(|| malformed("chunk data out of bounds"))?;
        let _ = entry_end;
        match id {
            b"Comp" => component = Some(&bytes[offset..end]),
            b"Cont" => controller = Some(&bytes[offset..end]),
            _ => {}
        }
    }
    let component = component.ok_or_else(|| malformed("no 'Comp' (component state) chunk"))?;
    Ok(Some(VstPresetChunks {
        component,
        controller,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成 .vstpreset を組み立てる（header 48B + データ + chunk list）。
    fn build_vstpreset(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"VST3");
        out.extend_from_slice(&1i32.to_le_bytes());
        out.extend_from_slice(&[b'A'; 32]); // class ID ASCII（parser は照合しない）
        let list_offset_field = out.len();
        out.extend_from_slice(&0i64.to_le_bytes()); // 後で埋める
        let mut entries = Vec::new();
        for (id, data) in chunks {
            let offset = out.len() as i64;
            out.extend_from_slice(data);
            entries.push((**id, offset, data.len() as i64));
        }
        let list_offset = out.len() as i64;
        out.extend_from_slice(b"List");
        out.extend_from_slice(&(entries.len() as i32).to_le_bytes());
        for (id, offset, size) in entries {
            out.extend_from_slice(&id);
            out.extend_from_slice(&offset.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
        }
        out[list_offset_field..list_offset_field + 8].copy_from_slice(&list_offset.to_le_bytes());
        out
    }

    #[test]
    fn vstpreset_extracts_comp_and_cont_chunks() {
        let preset = build_vstpreset(&[(b"Comp", b"component-state"), (b"Cont", b"ctrl")]);
        let chunks = parse(&preset)
            .expect("well-formed preset parses")
            .expect("VST3 magic is recognized");
        assert_eq!(chunks.component, b"component-state");
        assert_eq!(chunks.controller, Some(&b"ctrl"[..]));
    }

    #[test]
    fn vstpreset_without_cont_chunk_has_no_controller_state() {
        let preset = build_vstpreset(&[(b"Comp", b"component-only"), (b"Info", b"<xml/>")]);
        let chunks = parse(&preset)
            .expect("well-formed preset parses")
            .expect("VST3 magic is recognized");
        assert_eq!(chunks.component, b"component-only");
        assert_eq!(chunks.controller, None);
    }

    #[test]
    fn non_vstpreset_bytes_fall_back_to_raw_state() {
        // magic 無し = raw component state（呼び出し側がそのまま setState へ流す契約）。
        assert!(parse(b"OPAQ raw plugin state blob")
            .expect("raw bytes are not an error")
            .is_none());
        assert!(parse(b"").expect("empty is raw").is_none());
    }

    #[test]
    fn vstpreset_with_magic_but_broken_structure_is_an_error_not_raw() {
        // magic があるのに壊れている場合は raw 扱いに落とさず明示エラー（container ヘッダを
        // setState に流し込む silent 誤動作を防ぐ）。
        let truncated = b"VST3\x01\x00\x00\x00short";
        assert!(parse(truncated).is_err());

        // Comp チャンク欠如。
        let no_comp = build_vstpreset(&[(b"Info", b"<xml/>")]);
        assert!(parse(&no_comp).is_err());

        // chunk list offset が範囲外。
        let mut bad_offset = build_vstpreset(&[(b"Comp", b"x")]);
        let len = bad_offset.len() as i64;
        bad_offset[40..48].copy_from_slice(&(len + 100).to_le_bytes());
        assert!(parse(&bad_offset).is_err());

        // chunk データが範囲外（size がファイル末尾を超える）。
        let comp: &[u8] = b"state";
        let mut bad_size = build_vstpreset(&[(b"Comp", comp)]);
        let total_len = bad_size.len() as i64;
        let size_field = bad_size.len() - 8;
        bad_size[size_field..].copy_from_slice(&total_len.to_le_bytes());
        assert!(parse(&bad_size).is_err());
    }

    /// host 側（`orbit-vst3-host`）はこの文言を `Vst3HostError::State` にそのまま載せる。
    /// 移動前と同じ文言であることを固定する（ログ・E2E が文言で照合しうるため）。
    #[test]
    fn malformed_message_keeps_the_pre_move_wording() {
        let error = parse(b"VST3\x01\x00\x00\x00short").expect_err("truncated header is malformed");
        assert_eq!(
            error.to_string(),
            "malformed .vstpreset: header shorter than 48 bytes"
        );
    }
}
