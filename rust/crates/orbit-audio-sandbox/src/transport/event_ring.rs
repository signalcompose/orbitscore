//! child→host のイベントリング（Ordering を型に封じた SPSC）（#888 子 3・orbit-audio-sandbox）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(super)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use super::*;

/// evt リングの Ordering を型に封じる submodule（UIH.2a）。
///
/// `evt_arg` は非 atomic の `[u8; N]` で、直前の `std::ptr::write` を可視化するには
/// publish/read と ack/reuse の両方に Release/Acquire 対が**必須**（欠けると UB データレース）。
/// この必須性はテストでは守り切れない（ordering 定数の値を検査するテストは同語反復になり、
/// 呼び出し箇所の逸脱を検出できない）ため、**呼び出し箇所が Ordering を渡せない API** に固定する:
/// 内部の `AtomicU64` は本 submodule の外から不可視なので、
/// `evt_seq.store(seq, Ordering::Relaxed)` のような逸脱は**コンパイルできない**。
///
/// **同じ限界は「プログラム順序」の規律にもある**: payload（`evt_kind` / `evt_arg`）を
/// 書き終えてから [`ReleaseAcquireSeq::publish`] を呼ぶ、という呼び出し側の順序は本型でも
/// 強制できず、単一スレッドのユニットテストでは原理的に検出できない（program order 内では
/// どちらの順でも同じ結果になる）。publish を payload より先に呼ぶ逸脱はレビューだけが
/// ガードなので、`EventRingChild::service` の書き込み順を変えるときはこの doc に立ち返ること。
///
/// **既存の atomic フィールドには適用していない**（`cmd_seq` / `cmd_ack_seq` /
/// `seq_request` / `seq_tag` 等は生の `AtomicU64` のままで、呼び出し箇所ごとに Ordering を
/// 手書きする）。同型へ揃えるかは別工程 — `seq_request` / `seq_tag` は audio hot path が
/// 触るため、本 PR（#474 P2）の差分から大きくはみ出す。**新しい部分だけ守った状態である**
/// ことを承知の上での段階的導入であり、既存側が安全でないという意味ではない。
mod evt_sync {
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Release publish / Acquire read を型に固定した seq カーソル。
    ///
    /// `evt_seq`（payload publish → host read の対）と `evt_ack_seq`（ack → slot 再利用の対）の
    /// 両方が使う。[`SharedRegion`](super::SharedRegion) の repr(C) レイアウトを変えないため
    /// `repr(transparent)`（shm の zero 初期化とも互換）。
    #[repr(transparent)]
    pub struct ReleaseAcquireSeq(AtomicU64);

    impl ReleaseAcquireSeq {
        /// 非 atomic payload を書き終えた後に seq を公開する。Release store 固定。
        pub fn publish(&self, seq: u64) {
            self.0.store(seq, Ordering::Release);
        }

        /// 対岸の [`Self::publish`] と synchronizes-with する読み。Acquire load 固定。
        pub fn read(&self) -> u64 {
            self.0.load(Ordering::Acquire)
        }

        /// このフィールドの唯一の書き手自身による読み。自分の store とは program order で
        /// 整合するため Relaxed で十分（対岸の payload とは同期しない点に注意）。
        pub fn load_own(&self) -> u64 {
            self.0.load(Ordering::Relaxed)
        }
    }

    /// 累積水位（respawn でもリセットしない単調増加カウンタ）。`dirty_epoch` が使う。
    #[repr(transparent)]
    pub struct MonotoneEpoch(AtomicU64);

    impl MonotoneEpoch {
        /// 水位を 1 進め、新しい水位を返す。Release RMW 固定。
        ///
        /// `evt_seq` と違い `checked_add` を使わないのは意図的な非対称: こちらは通知スレッドを
        /// 問わない atomic RMW（`fetch_add`）で、overflow 検査を挟むには CAS ループ化が要る一方、
        /// 水位は slot 再利用判定に使われない（wrap しても UB クラスの故障に接続しない）ため
        /// u64 の実用上尽きない範囲で wrapping を許容する。
        pub fn increment(&self) -> u64 {
            self.0.fetch_add(1, Ordering::Release).wrapping_add(1)
        }

        /// [`Self::increment`] と synchronizes-with する読み。Acquire load 固定。
        pub fn read(&self) -> u64 {
            self.0.load(Ordering::Acquire)
        }
    }

    // repr(C) の SharedRegion に埋め込むため、newtype がレイアウトを変えないことを
    // コンパイル時に固定する（repr(transparent) の宣言忘れ・剥がし事故のガード）。
    const _: () = assert!(size_of::<ReleaseAcquireSeq>() == size_of::<AtomicU64>());
    const _: () = assert!(size_of::<MonotoneEpoch>() == size_of::<AtomicU64>());
}

pub use evt_sync::{MonotoneEpoch, ReleaseAcquireSeq};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PendingEvent {
    pub(super) kind: u32,
    pub(super) arg: [u8; EVT_ARG_BYTES],
}

/// child 側の取りこぼし不可イベント投函器（UIH.2a）。
///
/// [`Self::queue`] したイベントは [`Self::service`] が slot 再利用 guard に阻まれても
/// `pending` に残り、次の main-runloop tick で再試行できる。単一 child main thread から使う。
#[derive(Debug, Default)]
pub struct EventRingChild {
    pub(super) pending: VecDeque<PendingEvent>,
}

/// [`EventRingChild`] の失敗。**`arg` のエンコード失敗はここに無い**（規律1:
/// 取りこぼし不可イベントを付随情報の失敗に巻き込まない — [`EventRingChild::queue`] 参照）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventRingChildError {
    /// 呼び出し側のプログラミングエラー。「どのイベントか」自体が不明なので、
    /// フォールバックで enqueue するものが存在せず `Err` のままにする。
    UnknownKind(u32),
    SequenceExhausted,
}

impl fmt::Display for EventRingChildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownKind(kind) => write!(f, "unsupported child event kind {kind}"),
            Self::SequenceExhausted => write!(f, "event ring sequence exhausted"),
        }
    }
}

impl std::error::Error for EventRingChildError {}

impl EventRingChild {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取りこぼし不可イベントを保留する。実際の shm 投函は [`Self::service`] が行う。
    ///
    /// **規律1（[`service_command_mailbox`] の detail フォールバックの継承）**: `arg` が
    /// [`EVT_ARG_BYTES`] に収まらない・埋め込み NUL を含む場合でも、イベント自体は**必ず**
    /// enqueue する。arg は「[`EVT_ARG_FALLBACK`] + 元 arg のバイト長」へ差し替える。
    /// spec（UIH.2a）が取りこぼし不可と規定する `UI_CLOSED` / `UI_CLOSED_DONE` は、
    /// 動的な detail（OS エラー文字列・パス等）のエンコード失敗を理由に消えてはならない —
    /// 呼び出し元が `Result` を読み捨てると MCP `close_plugin_ui` の完了判定が永遠に閉じない。
    ///
    /// **差し替えの可視化は `evt_arg` の文言自体が担う**（host は poll で読める）。
    /// `tracing::warn!` も併発するが、これは best-effort — 出力の有無は呼び出し元プロセスが
    /// subscriber を持つかで決まる: `orbit-vst3-*-child` / `orbit-clap-*-child` は初期化しない
    /// ので無音（`tracing` は global subscriber 未設定なら黙って no-op）、**rack child
    /// （`orbit-effect-rack-child`・#628）は `macos::run()` が初期化するので stderr に出る**。
    /// in-process 利用・テストも subscriber 次第。
    ///
    /// `Err` は [`EventRingChildError::UnknownKind`] のみ（enum doc 参照）。
    pub fn queue(&mut self, kind: u32, arg: &str) -> Result<(), EventRingChildError> {
        if !matches!(kind, EVT_UI_CLOSED | EVT_UI_CLOSED_DONE) {
            return Err(EventRingChildError::UnknownKind(kind));
        }
        let mut bytes = [0; EVT_ARG_BYTES];
        if !write_cstr_field(&mut bytes, arg) {
            tracing::warn!(
                kind,
                arg_len = arg.len(),
                "event arg does not fit or contains NUL; replacing with fallback"
            );
            // 元の長さを host まで運ぶ（原因追跡の唯一の経路 — 上記 doc 参照）。
            // 文言全体が EVT_ARG_BYTES に収まることは EVT_ARG_FALLBACK 脇の const assert が保証。
            let fallback = format!("{EVT_ARG_FALLBACK} (original len {})", arg.len());
            let _ = write_cstr_field(&mut bytes, &fallback);
        }
        self.pending.push_back(PendingEvent { kind, arg: bytes });
        Ok(())
    }

    /// まだ shm へ publish できていない取りこぼし不可イベントの件数。
    /// 0 は「保留なし」を意味する(`is_empty` は同じ状態の別表現になるため置かない)。
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// リングがドレーン済みか（保留 0 件 かつ `evt_ack_seq == evt_seq`）。
    ///
    /// `evt_ack_seq` は host の Release publish を Acquire で読み、`evt_seq` は child 自身が
    /// publish するカーソルなので own-writer load を使う。Ordering は [`ReleaseAcquireSeq`]
    /// の型固定 API に委ね、ここでは手書きしない。
    ///
    /// # Safety
    /// `region` は生存中の [`SharedRegion`] を指していなければならない。
    pub unsafe fn is_drained(&self, region: *const SharedRegion) -> bool {
        self.pending.is_empty()
            && unsafe { (*region).evt_ack_seq.read() == (*region).evt_seq.load_own() }
    }

    /// slot が空く限り保留イベントを seq 順に publish する。
    ///
    /// `evt_ack_seq >= s - EVT_SLOTS` が偽なら先頭イベントを保持したまま戻る。payload を先に
    /// 書き、最後の `evt_seq` Release store で host に公開する。
    ///
    /// # Safety
    /// `region` は生存中の [`SharedRegion`] を指し、本メソッドの呼び出しは child の単一
    /// main thread に直列化されていなければならない。
    pub unsafe fn service(
        &mut self,
        region: *mut SharedRegion,
    ) -> Result<usize, EventRingChildError> {
        let mut published_count = 0;
        while let Some(event) = self.pending.front() {
            let previous = unsafe { (*region).evt_seq.load_own() };
            let seq = previous
                .checked_add(1)
                .ok_or(EventRingChildError::SequenceExhausted)?;
            let reusable_after = seq.saturating_sub(EVT_SLOTS as u64);
            let ack = unsafe { (*region).evt_ack_seq.read() };
            if ack < reusable_after {
                break;
            }

            let index = evt_slot_index(seq);
            unsafe {
                (*region).evt_kind[index].store(event.kind, Ordering::Relaxed);
                std::ptr::write(std::ptr::addr_of_mut!((*region).evt_arg[index]), event.arg);
                (*region).evt_seq.publish(seq);
            }
            self.pending.pop_front();
            published_count += 1;
        }
        Ok(published_count)
    }
}

/// host handler に渡す、shm から所有領域へコピー済みのイベント。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRingEvent {
    pub seq: u64,
    pub kind: u32,
    pub(super) arg: [u8; EVT_ARG_BYTES],
}

impl EventRingEvent {
    pub fn arg(&self) -> Option<&str> {
        read_cstr_field(&self.arg)
    }
}

/// [`EventRingHost::poll`] の結果。**idle / 前進 / 先頭で停止を型で区別する**（規律3:
/// [`CommandMailboxError::Timeout`] が停滞を型で loud にするのと同じ姿勢）。
///
/// spec の「故障時の脱出条件」（host は QUIT を立てる前に保留イベントを解決し、解決できない
/// ものは loud に報告して打ち切る）の判定材料を呼び出し元へ返す: [`Self::Blocked`] の
/// `seq` / `kind` が「何が解決できていないか」の報告内容そのものになる。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventPollOutcome {
    /// 新規イベントは無かった（`evt_ack_seq == evt_seq`）。
    Idle,
    /// 新規イベントを `handled` 件完結し ack した。未 ack は残っていない。
    /// 「>= 1」はコメントでなく型が保証する（0 件の前進は [`Self::Idle`] であり、
    /// `Advanced { handled: 0 }` は構築できない）。
    Advanced { handled: NonZeroUsize },
    /// handler が `seq` / `kind` のイベントの完結を拒んだ。`handled` 件はその前に ack 済み。
    /// 同じ seq が次回 poll の先頭に再登場する（seq 順処理: 追い越して前進しない）。
    Blocked { handled: usize, seq: u64, kind: u32 },
}

/// host 側の seq 順イベント consumer と dirty 水位 observer（UIH.2a）。
///
/// **evt カーソルを保持しない**（読む位置は毎 [`Self::poll`] で shm の `evt_ack_seq + 1` から
/// 導出する）。これは [`reset_child_starting`] が respawn 時に `evt_seq` / `evt_ack_seq` を
/// 0 に戻せる前提条件。カーソルフィールドを足す前に、同関数内の不変条件コメントを読むこと
/// （`last_seen_dirty_epoch` は累積水位 `dirty_epoch` に対する watermark であり、
/// `dirty_epoch` を respawn でリセットしないからこそ保持できている — 対になる設計）。
///
/// **スレッド安全性（`read → handler → ack` の原子性）**: [`Self::poll`] は `AtomicBool` の
/// CAS ゲートで排他する。[`CommandMailboxHost`] の「投函と reset の短い critical section
/// だけを `Mutex` で守り、待ち中は保持しない」規律とは**意図的に粒度が異なる**: evt 側は
/// handler の完了と `evt_ack_seq` の ack publish が原子でないと lost-update（同一イベントの
/// 重複処理）が起きるため、handler を含む全区間をゲートが覆う。任意の呼び出し元コード
/// （handler）がゲート内で走る以上、ブロッキングロックでは再入 = 自己 deadlock・
/// panic = 恒久 poison になる — だから待たずに fail-loud する CAS を使う。
///
/// この型が**提供する保証**:
/// - poll の read → handler → ack サイクルは host プロセス内で同時に 1 本しか走らない。
///   `evt_ack_seq` の Relaxed 読み（[`ReleaseAcquireSeq::load_own`]）が前提とする
///   「唯一の書き手」はこの排他が与える（child は `evt_ack_seq` を読むだけで書かない）。
/// - handler が panic してもゲートは RAII（[`PollGateGuard`]）で解放され、**次の poll は
///   成功する**（恒久 poison は無い）。panic したイベントは未 ack のまま残り、次の poll が
///   同じ seq から再配送する（handler が `false` を返したのと同じ位置に落ちる）。
///
/// この型が**提供しない保証**:
/// - **並行 poll の待機・直列化はしない**: ゲートが取れない poll は待たずに即 `Err` を返す。
///   **handler の中から同じ host の poll を呼ぶ再入も同じ `Err`**（deadlock はしないが
///   成功もしない）。UIH.2a の想定 poller は単一なので、複数スレッドから poll する設計に
///   変えるなら retry / 直列化は呼び出し側が持つこと。
/// - **[`reset_child_starting`] との排他**: 同関数はこのゲートの外にいる。従来どおり
///   `# Safety` 契約（watchdog が host 側の poll も静穏化してから呼ぶ）が要求する。
///
/// [`Self::observe_dirty_epoch`] は `fetch_max` の RMW で自己完結して並行安全なため
/// ゲートを取らない。現在は transport の不変条件テストだけが使う。
#[derive(Debug)]
pub(crate) struct EventRingHost {
    pub(super) shm_path: PathBuf,
    /// poll の read → handler → ack publish サイクルの排他フラグ（struct doc 参照）。
    /// `true` = poll 実行中。`Mutex` にしない理由も struct doc が持つ。
    pub(super) poll_gate: AtomicBool,
    #[allow(dead_code)]
    pub(super) last_seen_dirty_epoch: AtomicU64,
}

/// [`EventRingHost::poll_gate`] を handler panic 時にも確実に解放する RAII ガード。
///
/// これが `Mutex` の poison に対する回復経路の代替: unwind 中も `Drop` は走るので、
/// panic を跨いだ次の poll が恒久失敗しない。
pub(super) struct PollGateGuard<'a>(&'a AtomicBool);

impl Drop for PollGateGuard<'_> {
    fn drop(&mut self) {
        // Release store: 本 poll が書いた evt_ack_seq を、次にゲートを獲得する poll の
        // Acquire CAS へ可視化する（Mutex の unlock → lock と同じ happens-before を張る）。
        self.0.store(false, Ordering::Release);
    }
}

impl EventRingHost {
    pub(crate) fn new(shm_path: PathBuf) -> Self {
        Self {
            shm_path,
            poll_gate: AtomicBool::new(false),
            last_seen_dirty_epoch: AtomicU64::new(0),
        }
    }

    /// publish 済みイベントを `evt_ack_seq + 1` から順に処理する。
    ///
    /// handler が `true` を返したイベントだけを完了済みとして Release ack する。`false` なら
    /// その seq を未 ack のまま残し、後続を追い越さずに [`EventPollOutcome::Blocked`] を返す
    /// （idle との区別は戻り値の型が持つ — 規律3）。
    ///
    /// **再入不可**: handler の中から同じ host の poll を（直接・間接を問わず）呼ぶと、
    /// deadlock ではなく `Err` を返す。並行 poll も同様（待たない）。保証の全体は
    /// struct doc の「提供する保証 / 提供しない保証」を参照。
    pub(crate) fn poll<F>(&self, handler: F) -> io::Result<EventPollOutcome>
    where
        F: FnMut(EventRingEvent) -> bool,
    {
        let mmap = open_shared(&self.shm_path)?;
        self.poll_mapped(region_ptr(&mmap), handler)
    }

    /// `region` をすでに map 済みの coordinator 向け変種。poll gate と ack 規律は
    /// [`Self::poll`] と同一で、mapping の所有権だけを呼び出し側に残す。
    pub(super) fn poll_mapped<F>(
        &self,
        region: *mut SharedRegion,
        mut handler: F,
    ) -> io::Result<EventPollOutcome>
    where
        F: FnMut(EventRingEvent) -> bool,
    {
        // 排他の設計判断（CAS ゲート・fail-loud・panic 回復）は struct doc に集約してある。
        // 成功時 Acquire: 前回 poll の ack 書き込み（ガード解放の Release と対）を可視化する。
        if self
            .poll_gate
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return Err(io::Error::other(
                "event ring poll is non-reentrant: another poll is in progress on this host \
                 (a handler must not call poll, and concurrent pollers are not serialized)",
            ));
        }
        let _gate = PollGateGuard(&self.poll_gate);
        let mut handled = 0;
        loop {
            let ack = unsafe { (*region).evt_ack_seq.load_own() };
            let published = unsafe { (*region).evt_seq.read() };
            if ack > published {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("event ring ack {ack} exceeds published seq {published}"),
                ));
            }
            if ack == published {
                // NonZeroUsize が Idle / Advanced の境界を型で持つ（0 件の Advanced は構築不能）。
                return Ok(match NonZeroUsize::new(handled) {
                    None => EventPollOutcome::Idle,
                    Some(handled) => EventPollOutcome::Advanced { handled },
                });
            }

            let seq = ack + 1;
            let index = evt_slot_index(seq);
            let event = EventRingEvent {
                seq,
                kind: unsafe { (*region).evt_kind[index].load(Ordering::Relaxed) },
                arg: unsafe { std::ptr::read(std::ptr::addr_of!((*region).evt_arg[index])) },
            };
            let kind = event.kind;
            if !handler(event) {
                return Ok(EventPollOutcome::Blocked { handled, seq, kind });
            }
            unsafe { (*region).evt_ack_seq.publish(seq) };
            handled += 1;
        }
    }

    /// dirty 水位がこの host instance の前回観測値より進んだ場合、その新しい水位を返す。
    #[allow(dead_code)]
    pub(crate) fn observe_dirty_epoch(&self) -> io::Result<Option<u64>> {
        let mmap = open_shared(&self.shm_path)?;
        let region = region_ptr(&mmap);
        let current = unsafe { (*region).dirty_epoch.read() };
        let previous = self
            .last_seen_dirty_epoch
            .fetch_max(current, Ordering::Relaxed);
        Ok((current > previous).then_some(current))
    }
}

/// plugin dirty callback から水位を1進める。通知スレッドを問わず atomic RMW で安全。
///
/// # Safety
/// `region` は生存中の [`SharedRegion`] を指していなければならない。
pub unsafe fn increment_dirty_epoch(region: *mut SharedRegion) -> u64 {
    unsafe { (*region).dirty_epoch.increment() }
}
