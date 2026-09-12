//! 共有メモリの map/unmap と固定長フィールドの読み書き（#888 子 3・orbit-audio-sandbox）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(super)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use super::*;

/// 固定長バイト配列へ NUL 終端 UTF-8 を書く。収まらなければ `false`（**切り詰めない**）。
///
/// **埋め込み NUL を含む値も `false`**。UTF-8 として妥当でも、書けてしまうと
/// [`read_cstr_field`] が最初の NUL で切って読むため、**「切り詰めない」保証が黙って崩れる**。
/// 拒否側に倒して、保証をコメントではなくコードで守る。
pub fn write_cstr_field(dst: &mut [u8], value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() + 1 > dst.len() || bytes.contains(&0) {
        return false;
    }
    dst[..bytes.len()].copy_from_slice(bytes);
    dst[bytes.len()] = 0;
    true
}

/// 固定長バイト配列から NUL 終端 UTF-8 を読む。NUL が無い・非 UTF-8 なら `None`。
pub fn read_cstr_field(src: &[u8]) -> Option<&str> {
    let end = src.iter().position(|&b| b == 0)?;
    std::str::from_utf8(&src[..end]).ok()
}

/// UIH.3 のサイドカー書き込み。**`fsync` まで行う**。
///
/// `std::fs::write` は page cache に載った時点で成功を返す。host は ack 直後にこのファイルを
/// 読み、`PROJECT_FILE_SPEC` の atomic 書き込みで登記簿を確定させるので、**ack が
/// 「ディスクに載った」を意味しない**と、電源断で「登記簿は新しい state を指しているが
/// 実体は無い/古い」という状態になりうる。ack の意味を強くするのは child 側の責務。
pub fn write_sidecar(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// mailbox コマンド1件の処理結果。[`service_command_mailbox`] の handler が返す。
pub struct CommandOutcome {
    /// [`CMD_RESULT_OK`] 等の結果コード。
    pub result: u32,
    /// 成功時に生成したバイト数（[`CMD_SAVE_STATE`] ならサイドカーの長さ）。失敗時は 0。
    pub len: u64,
    /// 失敗理由。通常の成功時は空。UIH.4c の冪等 `CLOSE_UI` だけは成功時にも
    /// `"already-closing"` を運ぶ（`orbit_child_ui::CommandAck` からの mailbox 変換）。
    pub detail: String,
}

impl CommandOutcome {
    /// 成功。`len` は生成バイト数。
    pub fn ok(len: u64) -> Self {
        Self {
            result: CMD_RESULT_OK,
            len,
            detail: String::new(),
        }
    }

    /// 失敗。`result` は `CMD_RESULT_OK` 以外、`detail` は host に見せる理由。
    pub fn failed(result: u32, detail: impl Into<String>) -> Self {
        Self {
            result,
            len: 0,
            detail: detail.into(),
        }
    }
}

/// [`CMD_SAVE_STATE`] handler の**共通本体**。`capture` だけがフォーマット固有。
///
/// 4つの child binary（VST3 / CLAP × effect / instrument）はいずれも
/// 「cmd_arg を検証 → プラグインから state を吸い上げ → [`write_sidecar`] → 長さを返す」
/// という同じ手順を踏む。違うのは `capture_state()` のレシーバ型（`&` か `&mut` か、
/// `Vst3HostError` か `ClapHostError` か）だけで、それはクロージャの中に閉じる。
///
/// 各 child に手書きで置くと、**結果コードの割り当て**（空 arg = [`CMD_RESULT_BAD_ARG`] /
/// プラグイン失敗 = [`CMD_RESULT_PLUGIN_ERROR`] / 書き込み失敗 = [`CMD_RESULT_IO_ERROR`]）と
/// `detail` の文言が4箇所で独立に漂流する。host 側はこのコードで分岐するので、
/// 1形式だけ別のコードを返すようになっても型では捕まらない。
pub fn save_state_command<E: std::fmt::Display>(
    path_arg: Option<&str>,
    capture: impl FnOnce() -> Result<Vec<u8>, E>,
) -> CommandOutcome {
    let Some(path) = path_arg.filter(|candidate| !candidate.is_empty()) else {
        return CommandOutcome::failed(
            CMD_RESULT_BAD_ARG,
            "cmd_arg is empty or not NUL-terminated UTF-8",
        );
    };
    let bytes = match capture() {
        Ok(bytes) => bytes,
        Err(error) => return CommandOutcome::failed(CMD_RESULT_PLUGIN_ERROR, format!("{error}")),
    };
    // UIH.3 は fsync を要求する（`write_sidecar` が担う）。
    match write_sidecar(path, &bytes) {
        Ok(()) => CommandOutcome::ok(bytes.len() as u64),
        Err(error) => CommandOutcome::failed(CMD_RESULT_IO_ERROR, format!("write {path}: {error}")),
    }
}

/// mailbox に未処理コマンドがあれば `handler` へ渡し、結果を ack として publish する。
/// 未処理コマンドが無ければ何もせず `false` を返す。
///
/// **この関数がプロトコル不変条件を一手に引き受ける** — child 側はフォーマット固有の処理だけを
/// handler に書けばよい。分散させると publish 順序を child ごとに守り続ける必要が生じる。
///
/// instrument child は VST3 / CLAP とも配線済み。effect child も同じ handler seam を使う。
/// host は [`CommandMailboxHost`] を通して発行し、未対応 child / plugin hang を
/// [`PLUGIN_STATE_MAILBOX_TIMEOUT`] で loud に失敗させる。
///
/// 引き受ける不変条件:
/// - **未知の `cmd_kind` を黙って捨てない** — handler が `None` を返したら
///   [`CMD_RESULT_UNKNOWN_KIND`] で ack する（host が永久に待つのを防ぐ）。
/// - **detail を切り詰めない** — 収まらなければ固定文言へ倒す。
/// - **ack を最後に `Release` で publish する** — host は `cmd_ack_seq` を `Acquire` で
///   読むので、これにより result / len / detail の可視性が保証される。
///
/// handler は `(cmd_kind, cmd_arg)` を受け取る。`cmd_arg` は NUL 終端 UTF-8 として
/// 読めなければ `None`（handler 側で [`CMD_RESULT_BAD_ARG`] を返すか判断する）。
///
/// # host 側が守る前提（この関数では強制できない）
///
/// - **ack を受け取るまで次のコマンドを投函しない**（spec UIH.2 規律 0）。メールボックスは
///   1件分の領域しか持たないため、ack 前に `cmd_seq` を進めると前のコマンドは実行されずに
///   上書きされ、しかも新しい seq が ack されるので host からは成功に見える
/// - **respawn 時にメールボックスを reset する**（spec UIH.2 規律 0-b）。残った未処理コマンドを
///   replacement child が自分宛として実行してしまう
///
/// production host は [`CommandMailboxHost`] で単一未処理とexact ackを強制し、daemonの
/// effect/instrument watchdogは旧child死亡後に同じcoordinatorをresetしてからrespawnする。
///
/// # Safety
/// `region` は生存中の [`SharedRegion`] を指していなければならない。
pub unsafe fn service_command_mailbox<F>(region: *mut SharedRegion, handler: F) -> bool
where
    F: FnOnce(u32, Option<&str>) -> Option<CommandOutcome>,
{
    let seq = unsafe { (*region).cmd_seq.load(Ordering::Acquire) };
    if seq <= unsafe { (*region).cmd_ack_seq.load(Ordering::Relaxed) } {
        return false;
    }
    let kind = unsafe { (*region).cmd_kind.load(Ordering::Acquire) };
    let arg = unsafe { read_cstr_field(&(*region).cmd_arg) };
    let outcome = handler(kind, arg).unwrap_or_else(|| {
        CommandOutcome::failed(CMD_RESULT_UNKNOWN_KIND, format!("unknown cmd_kind {kind}"))
    });

    unsafe {
        if !write_cstr_field(&mut (*region).cmd_result_detail, &outcome.detail) {
            let _ = write_cstr_field(&mut (*region).cmd_result_detail, "detail too long");
        }
        (*region)
            .cmd_result_len
            .store(outcome.len, Ordering::Relaxed);
        (*region)
            .cmd_result
            .store(outcome.result, Ordering::Relaxed);
        (*region).cmd_ack_seq.store(seq, Ordering::Release);
    }
    true
}

/// 共有領域のバイトサイズ(mmap ファイルサイズ)。
pub const REGION_BYTES: usize = std::mem::size_of::<SharedRegion>();

/// 共有メモリファイルを作成して map する(host 側)。ファイルを `REGION_BYTES` に truncate
/// するので全 atomic / バッファは 0 初期化される(`seq_request = seq_done = 0` は有効な初期状態)。
///
/// # Note
/// 返した `MmapMut` が生存する限りのみ [`region_ptr`] のポインタは有効(本関数自体は safe)。
pub fn create_shared(path: &Path) -> io::Result<MmapMut> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.set_len(REGION_BYTES as u64)?;
    // SAFETY: ファイルは REGION_BYTES に拡張済み。map_mut は MAP_SHARED マッピングを返す。
    unsafe { MmapMut::map_mut(&file) }
}

/// 既存の共有メモリファイルを map する(child 側)。
///
/// # Note
/// 返した `MmapMut` が生存する限りのみ [`region_ptr`] のポインタは有効(本関数自体は safe)。
pub fn open_shared(path: &Path) -> io::Result<MmapMut> {
    #[cfg(test)]
    OPEN_SHARED_CALL_COUNT.with(|count| count.set(count.get() + 1));
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    // 不変条件(map 後の生ポインタ deref が UB にならない最低サイズ)をコード側で enforce する。
    // 旧 run の stale shm(別 SLOTS 等)を渡されても silently map せず弾く。
    let len = file.metadata()?.len();
    if len < REGION_BYTES as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("shm file too small: {len} < {REGION_BYTES} bytes"),
        ));
    }
    // SAFETY: ファイルは >= REGION_BYTES。host が REGION_BYTES に truncate 済みの同一ファイルを map する。
    unsafe { MmapMut::map_mut(&file) }
}

/// mmap のベースを [`SharedRegion`] ポインタにキャストする(本関数自体は safe)。
///
/// # Note
/// `mmap` は [`create_shared`] / [`open_shared`] が返したもの(サイズ >= `REGION_BYTES`・
/// ページ境界整列)でなければならない。返したポインタは `mmap` の生存期間を超えて使ってはならない。
pub fn region_ptr(mmap: &MmapMut) -> *mut SharedRegion {
    mmap.as_ptr() as *mut SharedRegion
}

/// child が plugin load 成功後に呼ぶ readiness 公開ヘルパ（PR-431）。`child_flags` を先に
/// Release store してから `child_status = CHILD_STATUS_READY` を Release store する
/// （host が status を Acquire で観測すれば flags も必ず可視という happens-before を
/// この1箇所に集約する）。
///
/// # Safety
/// `region` は呼び出し元が map 済みの生存 SharedRegion を指していること。
pub unsafe fn publish_child_ready(region: *mut SharedRegion, has_audio_input: bool) {
    let flags = if has_audio_input {
        CHILD_FLAG_HAS_AUDIO_INPUT
    } else {
        0
    };
    unsafe {
        (*region).child_flags.store(flags, Ordering::Release);
        (*region)
            .child_status
            .store(CHILD_STATUS_READY, Ordering::Release);
    }
}

/// child spawn の直前に readiness handshake を初期状態へ戻す。
///
/// shm は watchdog respawn 間で再利用されるため、前 incarnation の `READY` を残したまま
/// replacement child を起動すると host が新 child の load 完了前に ready-ack を誤認しうる。
/// status を先に `STARTING` にしてから flags を消し、全 spawn 経路で同じ順序を使う。
/// この順序なら並行 poller が前 incarnation の `READY` と消去済み flags を組み合わせない。
///
/// # Safety
/// - `region` は呼び出し元が map 済みの生存 SharedRegion を指していること。
/// - **child プロセス側**: watchdog が旧 child のプロセス消滅を確認済みであること
///   （生存中の child と並行すると `evt_seq` / `cmd_ack_seq` の並行 store で lost update）。
/// - **host プロセス側**: 同一 region に対する [`EventRingHost::poll`] が並行して
///   走っていないこと。poll 同士は host 内部の CAS ゲートで排他されるが、本関数は
///   そのゲートの外にいる。並行すると 4 つの独立 store（`evt_seq` → 0 / `evt_ack_seq` → 0 /
///   `evt_kind` / `evt_arg`）の途中状態を poll が観測し、偽の `InvalidData`
///   （`ack > published`）や正当な ack の消失になる。watchdog は「旧 child の死亡確認 →
///   in-flight 手続きの中止（poll 停止を含む）→ 本関数 → spawn」の順で直列化すること。
pub(crate) unsafe fn reset_child_starting(region: *mut SharedRegion) {
    unsafe {
        let seq = (*region).cmd_seq.load(Ordering::Acquire);
        let ack = (*region).cmd_ack_seq.load(Ordering::Relaxed);
        if seq > ack {
            let _ = write_cstr_field(
                &mut (*region).cmd_result_detail,
                "child exited before completing the command",
            );
            (*region).cmd_result_len.store(0, Ordering::Relaxed);
            (*region)
                .cmd_result
                .store(CMD_RESULT_CHILD_EXITED, Ordering::Relaxed);
            // failure payload を先に書き、ack を最後に publish する。
            (*region).cmd_ack_seq.store(seq, Ordering::Release);
        }
        (*region).cmd_kind.store(CMD_NONE, Ordering::Relaxed);
        (*region).cmd_arg.fill(0);

        // 旧 child の未処理イベントを replacement child のものと混線させない。並行 writer の
        // 不在（child のプロセス消滅 + host 内 poll の静穏化の両方）は # Safety 契約が要求する。
        //
        // ここで evt_seq / evt_ack_seq を 0 に戻せるのは、`cmd_seq`（0 に戻さない —
        // [`InFlightCommand::generation`] のコメント参照）と違い、**host 側が evt カーソルを
        // 一切保持しない**から: [`EventRingHost::poll`] は読む位置を毎回 shm の
        // `evt_ack_seq + 1` から導出するので、0 リセット後も desync しようがない。
        //
        // 不変条件: `EventRingHost` に evt カーソル（最後に見た seq 等）のフィールドを
        // 追加してはならない。追加するなら、この 0 リセットをやめて `cmd_seq` と同じく
        // 単調増加（+ generation 防御）へ移行すること。さもないと host-local の旧値を
        // 再超過するまで黙ってイベントを取りこぼす（`dirty_epoch` を 0 に戻した場合に
        // 起きる故障と同型）。この不変条件は
        // tests::event_ring_host_survives_respawn_seq_reset_without_local_cursor が実行で守る。
        (*region).evt_seq.publish(0);
        (*region).evt_ack_seq.publish(0);
        for kind in &(*region).evt_kind {
            kind.store(EVT_NONE, Ordering::Relaxed);
        }
        (*region).evt_arg.fill([0; EVT_ARG_BYTES]);

        // dirty_epoch は累積水位であり、host-local last_seen と比較するため respawn では触れない。
        (*region)
            .child_status
            .store(CHILD_STATUS_STARTING, Ordering::Release);
        (*region).child_flags.store(0, Ordering::Release);
    }
}

/// attach 失敗後に同じ shm を次の child incarnation へ引き継ぐ前、teardown が書いた QUIT を解除する。
///
/// # Safety
/// `region` は呼び出し元が map 済みの生存 SharedRegion を指していること。
pub unsafe fn reset_control_run(region: *mut SharedRegion) {
    unsafe { (*region).control.store(CONTROL_RUN, Ordering::Release) }
}
