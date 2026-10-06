//! VST3 `.vstpreset` container の読み書き（解析 #540 P2 / 書き出し #982）。
//!
//! 解析は `orbit-vst3-host` の `host/setup.rs` から移した（#982）。`orbit-vst3-host` は crate 全体が
//! macOS 専用で、CI（ubuntu）ではテストが走らない。ファイル形式の扱いは COM にも
//! CoreFoundation にも依存しないので、全プラットフォームでビルドできる crate に置く。
//!
//! 形式と保存の規定は `docs/specs-v2/PLUGIN_CAPABILITY_ABSTRACTION_v1.md` CAP.2a。形式の一次ソースは
//! VST3 SDK `public.sdk/source/vst/vstpresetfile.{h,cpp}`（`PresetFile::savePreset`）:
//!
//! ```text
//! header  'VST3' | int32 version (= 1) | class ID ASCII 32 bytes | int64 chunk-list offset
//! data    Comp（component state）→ Cont（controller state・任意）
//! list    'List' | int32 count | count × { id 4 bytes | int64 offset | int64 size }
//! ```
//!
//! 整数はすべて little-endian（SDK は big-endian 機でだけ swap する）。

use std::error::Error;
use std::fmt::{Display, Formatter};

const MAGIC: &[u8; 4] = b"VST3";
const FORMAT_VERSION: i32 = 1;
const HEADER_SIZE: usize = 48;
const COMPONENT_CHUNK: &[u8; 4] = b"Comp";
const CONTROLLER_CHUNK: &[u8; 4] = b"Cont";
const LIST_CHUNK: &[u8; 4] = b"List";

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
    if bytes.len() < 4 || &bytes[0..4] != MAGIC {
        return Ok(None);
    }
    let malformed = |reason: &str| MalformedPreset(reason.to_string());
    if bytes.len() < HEADER_SIZE {
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
    if &bytes[list_offset..list_offset + 4] != LIST_CHUNK {
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
            id if id == COMPONENT_CHUNK => component = Some(&bytes[offset..end]),
            id if id == CONTROLLER_CHUNK => controller = Some(&bytes[offset..end]),
            _ => {}
        }
    }
    let component = component.ok_or_else(|| malformed("no 'Comp' (component state) chunk"))?;
    Ok(Some(VstPresetChunks {
        component,
        controller,
    }))
}

/// class ID（16 bytes）を `.vstpreset` header の 32 文字へ写す。
///
/// SDK の `FUID::toString` と同じ書式。macOS / Linux は `COM_COMPATIBLE = 0`
/// （`pluginterfaces/base/fplatform.h`）なので、16 bytes を先頭から順に `%02X` で並べる
/// （`pluginterfaces/base/funknown.cpp`）。Windows の COM 互換レイアウトは扱わない
/// （OrbitScore のホストは macOS だけ）。
pub fn class_id_ascii(class_id: &[u8; 16]) -> [u8; 32] {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = [0u8; 32];
    for (index, byte) in class_id.iter().enumerate() {
        out[index * 2] = HEX[usize::from(byte >> 4)];
        out[index * 2 + 1] = HEX[usize::from(byte & 0x0F)];
    }
    out
}

/// `.vstpreset` container を組み立てる（CAP.2a の 1）。
///
/// `class_id` は component（processor）の class ID。chunk の並びは SDK の `savePreset` と同じ
/// （header → `Comp` → `Cont` → chunk list）。`controller` が `None` なら `Cont` を書かない。
/// どれを `Cont` に渡すかは [`controller_chunk_to_store`] が決める。
pub fn build(class_id: &[u8; 16], component: &[u8], controller: Option<&[u8]>) -> Vec<u8> {
    let mut chunks = vec![(COMPONENT_CHUNK, component)];
    if let Some(controller) = controller {
        chunks.push((CONTROLLER_CHUNK, controller));
    }
    let data_len: usize = chunks.iter().map(|(_, data)| data.len()).sum();
    let mut out = Vec::with_capacity(HEADER_SIZE + data_len + 8 + chunks.len() * 20);

    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.extend_from_slice(&class_id_ascii(class_id));
    let list_offset = HEADER_SIZE + data_len;
    out.extend_from_slice(&to_i64(list_offset).to_le_bytes());

    let mut entries = Vec::with_capacity(chunks.len());
    for (id, data) in &chunks {
        entries.push((*id, out.len(), data.len()));
        out.extend_from_slice(data);
    }
    debug_assert_eq!(out.len(), list_offset);

    out.extend_from_slice(LIST_CHUNK);
    let count = i32::try_from(entries.len()).expect("at most two chunks are written");
    out.extend_from_slice(&count.to_le_bytes());
    for (id, offset, size) in entries {
        out.extend_from_slice(id);
        out.extend_from_slice(&to_i64(offset).to_le_bytes());
        out.extend_from_slice(&to_i64(size).to_le_bytes());
    }
    out
}

/// メモリ上のバイト列の長さは `isize::MAX` を超えないので、`i64` に必ず収まる。
fn to_i64(value: usize) -> i64 {
    i64::try_from(value).expect("an in-memory length always fits in i64")
}

/// 保存する controller chunk を決める（CAP.2a の 2）。`None` なら `Cont` を書かない。
///
/// - `controller` が `None`（controller が無い・`getState` が未実装か失敗）→ 書かない
/// - 0 バイト → 書かない（SDK は空の `Cont` を書くが、復元で空の `setState` を呼ぶだけになる）
/// - `controller_is_component`（単一コンポーネント）で `component` と同じバイト列 → 書かない。
///   同じ実装が 2 つの口で答えているので、書くと復元で全 state の `setState` が 2 回走る
pub fn controller_chunk_to_store<'a>(
    component: &[u8],
    controller: Option<&'a [u8]>,
    controller_is_component: bool,
) -> Option<&'a [u8]> {
    if controller_echoes_component(component, controller, controller_is_component) {
        return None;
    }
    controller.filter(|state| !state.is_empty())
}

/// 単一コンポーネントの plugin が、controller の口でも component state をそのまま返したか。
///
/// `true` なら同じ実装が 2 つの口で答えている。plugin の実装は実行中に変わらないので、
/// host はこれを覚えておけば次の保存から controller の `getState` を省ける
/// （Kontakt 級では state のシリアライズ 1 回分）。
pub fn controller_echoes_component(
    component: &[u8],
    controller: Option<&[u8]>,
    controller_is_component: bool,
) -> bool {
    controller_is_component
        && controller.is_some_and(|state| !state.is_empty() && state == component)
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

    // ── #982: 書き出し ─────────────────────────────────────────────────────────

    const CLASS_ID: [u8; 16] = [
        0x6E, 0x33, 0x22, 0x52, 0x54, 0x22, 0x4A, 0x00, 0xAA, 0x69, 0x30, 0x1A, 0xF3, 0x18, 0x79,
        0x7D,
    ];

    /// SDK `FUID::toString`（COM_COMPATIBLE = 0）: 16 bytes を先頭から順に `%02X`。
    /// 期待値は gain oracle の doc にある Processor CID（`6E332252-54224A00-AA69301A-F318797D`）。
    #[test]
    fn class_id_is_written_as_uppercase_hex_in_byte_order() {
        assert_eq!(
            &class_id_ascii(&CLASS_ID),
            b"6E33225254224A00AA69301AF318797D"
        );
    }

    /// 書き出しのバイト列を **parser を使わずに**手で組んだ期待値と突き合わせる。
    /// 往復テストだけだと、書き出しと解析が同じ向きに間違えたとき（例: offset を 1 ずらす）に
    /// 気づけない。並びは SDK の `savePreset` と同じ（header → Comp → Cont → List）。
    #[test]
    fn build_matches_the_sdk_layout_byte_for_byte() {
        let mut expected = Vec::new();
        expected.extend_from_slice(b"VST3");
        expected.extend_from_slice(&1i32.to_le_bytes());
        expected.extend_from_slice(b"6E33225254224A00AA69301AF318797D");
        expected.extend_from_slice(&51i64.to_le_bytes()); // 48 + Comp 2 + Cont 1
        expected.extend_from_slice(b"AB");
        expected.extend_from_slice(b"C");
        expected.extend_from_slice(b"List");
        expected.extend_from_slice(&2i32.to_le_bytes());
        expected.extend_from_slice(b"Comp");
        expected.extend_from_slice(&48i64.to_le_bytes());
        expected.extend_from_slice(&2i64.to_le_bytes());
        expected.extend_from_slice(b"Cont");
        expected.extend_from_slice(&50i64.to_le_bytes());
        expected.extend_from_slice(&1i64.to_le_bytes());

        assert_eq!(build(&CLASS_ID, b"AB", Some(b"C")), expected);
    }

    #[test]
    fn build_without_controller_writes_only_the_comp_entry() {
        let mut expected = Vec::new();
        expected.extend_from_slice(b"VST3");
        expected.extend_from_slice(&1i32.to_le_bytes());
        expected.extend_from_slice(b"6E33225254224A00AA69301AF318797D");
        expected.extend_from_slice(&50i64.to_le_bytes());
        expected.extend_from_slice(b"AB");
        expected.extend_from_slice(b"List");
        expected.extend_from_slice(&1i32.to_le_bytes());
        expected.extend_from_slice(b"Comp");
        expected.extend_from_slice(&48i64.to_le_bytes());
        expected.extend_from_slice(&2i64.to_le_bytes());

        assert_eq!(build(&CLASS_ID, b"AB", None), expected);
    }

    #[test]
    fn build_and_parse_round_trip() {
        let component = vec![0x5Au8; 1000];
        let controller = b"editor settings".to_vec();

        let with_controller = build(&CLASS_ID, &component, Some(&controller));
        let chunks = parse(&with_controller)
            .expect("written preset parses")
            .expect("written preset carries the VST3 magic");
        assert_eq!(chunks.component, &component[..]);
        assert_eq!(chunks.controller, Some(&controller[..]));

        let without_controller = build(&CLASS_ID, &component, None);
        let chunks = parse(&without_controller)
            .expect("written preset parses")
            .expect("written preset carries the VST3 magic");
        assert_eq!(chunks.component, &component[..]);
        assert_eq!(chunks.controller, None);
    }

    /// 旧形式の raw component chunk がたまたま `VST3` で始まると container と誤読される。
    /// 書き出しを常に container にすれば、新しく書くファイルではこの曖昧さが起きない。
    #[test]
    fn a_component_state_starting_with_the_magic_still_round_trips() {
        let component = b"VST3 looks like a header but is plugin data";
        let chunks_bytes = build(&CLASS_ID, component, None);
        let chunks = parse(&chunks_bytes)
            .expect("written preset parses")
            .expect("written preset carries the VST3 magic");
        assert_eq!(chunks.component, component);
    }

    // CAP.2a の 2: 保存する controller chunk の選び方。

    #[test]
    fn no_controller_state_stores_no_cont_chunk() {
        assert_eq!(controller_chunk_to_store(b"comp", None, false), None);
        assert_eq!(controller_chunk_to_store(b"comp", None, true), None);
    }

    #[test]
    fn an_empty_controller_state_stores_no_cont_chunk() {
        assert_eq!(controller_chunk_to_store(b"comp", Some(b""), false), None);
        assert_eq!(controller_chunk_to_store(b"comp", Some(b""), true), None);
    }

    #[test]
    fn a_separate_controller_state_is_stored_as_is() {
        assert_eq!(
            controller_chunk_to_store(b"comp", Some(b"ctrl"), false),
            Some(&b"ctrl"[..])
        );
        // 別オブジェクトの controller が component と同じバイト列を返しても、それはその
        // controller が自分で書いた state なので保存する（同一判定は単一コンポーネントだけ）。
        assert_eq!(
            controller_chunk_to_store(b"same", Some(b"same"), false),
            Some(&b"same"[..])
        );
    }

    #[test]
    fn a_single_component_plugin_echoing_its_component_state_stores_no_cont_chunk() {
        // 同じ実装が 2 つの口で答えている。付けると復元で setState が 2 回走る。
        assert_eq!(
            controller_chunk_to_store(b"same", Some(b"same"), true),
            None
        );
    }

    #[test]
    fn only_a_single_component_plugin_returning_its_component_state_is_an_echo() {
        assert!(controller_echoes_component(b"same", Some(b"same"), true));
        assert!(!controller_echoes_component(b"same", Some(b"same"), false));
        assert!(!controller_echoes_component(b"comp", Some(b"editor"), true));
        assert!(!controller_echoes_component(b"comp", None, true));
        // 空同士は「同じ実装」の証拠にならない（何も書かない controller はよくある）。
        assert!(!controller_echoes_component(b"", Some(b""), true));
    }

    #[test]
    fn a_single_component_plugin_with_distinct_editor_state_stores_it() {
        // SDK の SingleComponentEffect は IEditController::getState を別名
        // （getEditorState）で実装できる。中身が違えばそれは controller の state。
        assert_eq!(
            controller_chunk_to_store(b"comp", Some(b"editor"), true),
            Some(&b"editor"[..])
        );
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
