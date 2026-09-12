//! プラグイン UI イベントポンプ（ライフサイクル・safepoint・放棄コマンドの後始末）（#888 子 3・orbit-audio-sandbox）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(super)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use super::*;

#[derive(Debug)]
pub enum UiEventPumpError {
    Mapping(io::Error),
    Mailbox(CommandMailboxError),
    CoordinatorPoisoned,
    GenerationMismatch { expected: u64, actual: u64 },
    Protocol(String),
}

impl fmt::Display for UiEventPumpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mapping(error) => write!(f, "plugin UI event mapping failed: {error}"),
            Self::Mailbox(error) => write!(f, "plugin UI reset mailbox failed: {error}"),
            Self::CoordinatorPoisoned => write!(f, "plugin UI event pump coordinator poisoned"),
            Self::GenerationMismatch { expected, actual } => write!(
                f,
                "plugin UI safepoint generation mismatch: current {expected}, got {actual}"
            ),
            Self::Protocol(detail) => write!(f, "plugin UI event protocol error: {detail}"),
        }
    }
}

impl std::error::Error for UiEventPumpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Mapping(error) => Some(error),
            Self::Mailbox(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for UiEventPumpError {
    fn from(error: io::Error) -> Self {
        Self::Mapping(error)
    }
}

impl From<CommandMailboxError> for UiEventPumpError {
    fn from(error: CommandMailboxError) -> Self {
        Self::Mailbox(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UiLifecycle {
    Closed,
    Opening,
    Open,
    Closing,
}

#[derive(Debug, Default)]
pub(super) struct UiPumpState {
    pub(super) generation: u64,
    /// Engine へ通知済みで、`AckUiSafepoint` を待っている `UI_CLOSED`。
    pub(super) pending_safepoint: Option<PendingSafepoint>,
    /// Window ごとの lifecycle と、遅着 ack を warn 付きで受理するための放棄水位。
    pub(super) windows: BTreeMap<UiWindowKey, UiWindowState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct PendingSafepoint {
    pub(super) window: UiWindowKey,
    pub(super) evt_seq: u64,
}

#[derive(Debug)]
pub(super) struct UiWindowState {
    pub(super) lifecycle: UiLifecycle,
    pub(super) abandoned_safepoint: Option<u64>,
}

/// child UI event ring と respawn reset を一つの排他契約へ束ねる host coordinator。
///
/// # 提供する保証
///
/// - `poll_step` は **pump の Mutex を保持したまま** [`EventRingHost::poll`] の
///   read → 固定 handler → ack 全区間を実行する。`ack_safepoint`、teardown drain、respawn
///   reset も同じ Mutex を取るため、#592 の `evt_seq=0` リセット途中を poll が観測しない。
/// - `reset_after_child_exit` は pump lock の内側で
///   [`CommandMailboxHost::reset_after_child_exit`] を呼ぶ。全呼び出しの lock 順序は
///   **pump → mailbox** に固定し、逆順の経路を提供しない。
/// - [`CommandMailboxHost`] から継承する保証は、通常の command 発行と reset の host 内直列化、
///   generation による世代跨ぎの command ack 横取り防止、および
///   `reset_after_child_exit` を旧 child の死亡確認後にだけ呼ぶという契約である。
/// - generation と通知済み safepoint 水位を同じ state に置くため、respawn で `evt_seq` が 0 に
///   巻き戻っても旧世代の `AckUiSafepoint` は loud に拒否される。
/// - handler は `UiPumpNotification` の enqueue、水位判定、既知 kind の lifecycle 簿記だけで、
///   呼び出し側が任意の ring handler を差し込むことはできない。
///
/// # 提供しない保証 / sink の契約
///
/// - sink の配送完了や engine 側保存は待たない。sink は **非ブロッキング enqueue のみ**で
///   なければならない。pump lock 内で channel capacity 待ち、I/O、別 task の join 等を行うと
///   watchdog と respawn を停止させる。`false` は enqueue 不能を意味し、イベントを未 ack のまま
///   次回へ残す。
/// - child の 10 秒 close timeout より前に daemon 独自の timeout を設けない。脱出は child が
///   `UI_CLOSED_DONE(timeout-without-save)` を publish した事実だけを根拠にする。
/// - host 内 Mutex は、生存中の child process による共有メモリ store を止めない。したがって
///   **生存中の child と reset の cross-process 競合は守られず**、reset は死亡確認後に限る。
/// - [`EventRingHost`] の CAS gate は pump 導入後の reset 排他の主役ではない。pump を経ない
///   raw/direct poll の同時実行を fail-loud に検出する防御線として残る。
/// - generation は世代跨ぎの ack を拒否するが、**同一 generation 内で別の `evt_seq` を
///   取り違えることまでは守らない**。`pending_safepoint` と in-order head の一致検査が別途必要。
/// - raw [`EventRingHost`] / [`reset_child_starting`] は crate 外へ公開せず、他 crate が pump を
///   迂回することを型で禁止する。crate 内の transport 実装・テストは本契約を維持する責務を持つ。
#[derive(Debug)]
pub struct UiEventPump {
    pub(super) ring: EventRingHost,
    pub(super) state: Mutex<UiPumpState>,
}

/// respawn reset が UI lifecycle に与えた結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiPumpResetOutcome {
    pub closed_windows: Vec<UiWindowKey>,
    pub generation: u64,
}

impl UiEventPump {
    pub fn new(shm_path: PathBuf) -> Self {
        Self {
            ring: EventRingHost::new(shm_path),
            state: Mutex::new(UiPumpState::default()),
        }
    }

    /// OPEN_UI 投函直前に lifecycle を予約する。command 失敗時は [`Self::finish_open`] へ
    /// `false` を渡して戻す。すでに open/closing なら child へ投函する前に loud に拒否する。
    pub fn begin_open(&self, window: UiWindowKey) -> Result<(), UiEventPumpError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        let lifecycle = state
            .windows
            .get(&window)
            .map(|window| window.lifecycle)
            .unwrap_or(UiLifecycle::Closed);
        if lifecycle != UiLifecycle::Closed {
            return Err(UiEventPumpError::Protocol(format!(
                "OPEN_UI requested while lifecycle is {:?} (window {window:?})",
                lifecycle
            )));
        }
        state.windows.insert(
            window,
            UiWindowState {
                lifecycle: UiLifecycle::Opening,
                abandoned_safepoint: None,
            },
        );
        Ok(())
    }

    pub fn finish_open(
        &self,
        window: UiWindowKey,
        succeeded: bool,
    ) -> Result<(), UiEventPumpError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        if let Some(window_state) = state.windows.get_mut(&window) {
            if window_state.lifecycle != UiLifecycle::Opening {
                return Ok(());
            }
            window_state.lifecycle = if succeeded {
                UiLifecycle::Open
            } else {
                UiLifecycle::Closed
            };
        }
        remove_settled_window(&mut state, window);
        Ok(())
    }

    /// watchdog の1 tick。固定 handler は broadcast 等への enqueue と水位判定だけを行う。
    pub fn poll_step<F>(&self, mut sink: F) -> Result<EventPollOutcome, UiEventPumpError>
    where
        F: FnMut(UiPumpNotification) -> bool,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        let mmap = open_shared(&self.ring.shm_path)?;
        let region = region_ptr(&mmap);
        let mut handler_error = None;
        let outcome = self.ring.poll_mapped(region, |event| match event.kind {
            EVT_UI_CLOSED => {
                let window = match decode_ui_closed_arg(event.arg()) {
                    Ok(window) => window,
                    Err(detail) => {
                        handler_error = Some(UiEventPumpError::Protocol(format!(
                            "UI_CLOSED seq {} has invalid argument: {detail}",
                            event.seq
                        )));
                        return false;
                    }
                };
                state
                    .windows
                    .entry(window)
                    .or_insert(UiWindowState {
                        lifecycle: UiLifecycle::Closed,
                        abandoned_safepoint: None,
                    })
                    .lifecycle = UiLifecycle::Closing;

                // Abandon takes precedence over notification delivery. Once the child has
                // published timeout-without-save it has already given up, so no engine save can
                // still happen. Retrying an undeliverable safepoint first would leave this ring
                // head blocked forever while no editor is connected and prevent a later UI open.
                if is_abandon_done_published(region, event.seq.saturating_add(1), window) {
                    tracing::warn!(
                        generation = state.generation,
                        evt_seq = event.seq,
                        ?window,
                        "plugin UI safepoint was abandoned after child timeout; acking the blocked head"
                    );
                    state.pending_safepoint = None;
                    state
                        .windows
                        .get_mut(&window)
                        .expect("closing window entry exists")
                        .abandoned_safepoint = Some(event.seq);
                    return true;
                }

                let pending = PendingSafepoint {
                    window,
                    evt_seq: event.seq,
                };
                if state.pending_safepoint != Some(pending) {
                    if !sink(UiPumpNotification::Safepoint {
                        generation: state.generation,
                        evt_seq: event.seq,
                        window,
                    }) {
                        return false;
                    }
                    state.pending_safepoint = Some(pending);
                }
                false
            }
            EVT_UI_CLOSED_DONE => {
                let (window, completion) = match decode_ui_closed_done_arg(event.arg()) {
                    Ok(decoded) => decoded,
                    Err(detail) => {
                        handler_error = Some(UiEventPumpError::Protocol(format!(
                            "UI_CLOSED_DONE seq {} has invalid argument: {detail}",
                            event.seq
                        )));
                        return false;
                    }
                };
                if sink(UiPumpNotification::CloseDone { completion, window }) {
                    state
                        .windows
                        .entry(window)
                        .or_insert(UiWindowState {
                            lifecycle: UiLifecycle::Closed,
                            abandoned_safepoint: None,
                        })
                        .lifecycle = UiLifecycle::Closed;
                    remove_settled_window(&mut state, window);
                    true
                } else {
                    false
                }
            }
            kind => {
                handler_error = Some(UiEventPumpError::Protocol(format!(
                    "event seq {} has unknown kind {kind}",
                    event.seq
                )));
                false
            }
        })?;
        match handler_error {
            Some(error) => Err(error),
            None => Ok(outcome),
        }
    }

    /// engine が safepoint 保存・atomic rename・project 登記まで完了した時だけ ack を進める。
    pub fn ack_safepoint(
        &self,
        generation: u64,
        window: UiWindowKey,
        evt_seq: u64,
    ) -> Result<(), UiEventPumpError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        if generation != state.generation {
            return Err(UiEventPumpError::GenerationMismatch {
                expected: state.generation,
                actual: generation,
            });
        }
        let mmap = open_shared(&self.ring.shm_path)?;
        let region = region_ptr(&mmap);
        let ack = unsafe { (*region).evt_ack_seq.load_own() };
        let late_abandoned = state
            .windows
            .get(&window)
            .is_some_and(|state| state.abandoned_safepoint == Some(evt_seq));
        if late_abandoned && ack >= evt_seq {
            tracing::warn!(
                generation,
                evt_seq,
                ?window,
                "late plugin UI safepoint ack arrived after timeout-without-save; accepting completed save"
            );
            state
                .windows
                .get_mut(&window)
                .expect("abandoned window entry exists")
                .abandoned_safepoint = None;
            remove_settled_window(&mut state, window);
            return Ok(());
        }
        let requested = PendingSafepoint { window, evt_seq };
        if state.pending_safepoint != Some(requested) {
            return Err(UiEventPumpError::Protocol(format!(
                "AckUiSafepoint (window {window:?}, seq {evt_seq}) does not match pending {:?}",
                state.pending_safepoint
            )));
        }
        let published = unsafe { (*region).evt_seq.read() };
        if ack.saturating_add(1) != evt_seq || evt_seq > published {
            return Err(UiEventPumpError::Protocol(format!(
                "AckUiSafepoint seq {evt_seq} is not the in-order head (ack={ack}, published={published})"
            )));
        }
        unsafe { (*region).evt_ack_seq.publish(evt_seq) };
        state.pending_safepoint = None;
        Ok(())
    }

    /// 旧 child の死亡確認後、replacement spawn 前に呼ぶ唯一の daemon reset 経路。
    pub fn reset_after_child_exit(
        &self,
        mailbox: &CommandMailboxHost,
    ) -> Result<UiPumpResetOutcome, UiEventPumpError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        let closed_windows = state
            .windows
            .iter()
            .filter_map(|(window, window_state)| {
                (window_state.lifecycle != UiLifecycle::Closed).then_some(*window)
            })
            .collect();
        if let Some(pending) = state.pending_safepoint.take() {
            tracing::error!(
                generation = state.generation,
                evt_seq = pending.evt_seq,
                window = ?pending.window,
                "plugin child exited with a UI safepoint waiter pending"
            );
        }
        // LOCK ORDER: pump state -> command mailbox. No code may acquire these in reverse.
        mailbox.reset_after_child_exit()?;
        state.generation = state.generation.wrapping_add(1);
        state.windows.clear();
        Ok(UiPumpResetOutcome {
            closed_windows,
            generation: state.generation,
        })
    }

    /// 正常 teardown の QUIT 前に、現在 publish 済みのイベントを最終処理する。
    ///
    /// safepoint は停止により完遂不能なので error を残して ack し、DONE の enqueue 不能も error
    /// を残して打ち切る。これは時間経過による daemon timeout ではなく、明示 teardown の終端処理。
    pub fn final_drain<F>(&self, mut sink: F) -> Result<EventPollOutcome, UiEventPumpError>
    where
        F: FnMut(UiPumpNotification) -> bool,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| UiEventPumpError::CoordinatorPoisoned)?;
        let outcome = self.ring.poll(|event| {
            match event.kind {
                EVT_UI_CLOSED => {
                    let window = match decode_ui_closed_arg(event.arg()) {
                        Ok(window) => window,
                        Err(detail) => {
                            tracing::error!(
                                evt_seq = event.seq,
                                %detail,
                                "teardown is discarding malformed UI_CLOSED"
                            );
                            return true;
                        }
                    };
                    state
                        .windows
                        .entry(window)
                        .or_insert(UiWindowState {
                            lifecycle: UiLifecycle::Closed,
                            abandoned_safepoint: None,
                        })
                        .lifecycle = UiLifecycle::Closing;
                    let pending = PendingSafepoint {
                        window,
                        evt_seq: event.seq,
                    };
                    if state.pending_safepoint != Some(pending)
                        && !sink(UiPumpNotification::Safepoint {
                            generation: state.generation,
                            evt_seq: event.seq,
                            window,
                        })
                    {
                        tracing::error!(
                            evt_seq = event.seq,
                            "teardown could not enqueue final plugin UI safepoint notification"
                        );
                    }
                    tracing::error!(
                        generation = state.generation,
                        evt_seq = event.seq,
                        "teardown is abandoning an incomplete plugin UI safepoint before QUIT"
                    );
                    state.pending_safepoint = None;
                    state
                        .windows
                        .get_mut(&window)
                        .expect("closing window entry exists")
                        .abandoned_safepoint = Some(event.seq);
                }
                EVT_UI_CLOSED_DONE => {
                    let (window, completion) = match decode_ui_closed_done_arg(event.arg()) {
                        Ok(decoded) => decoded,
                        Err(detail) => {
                            tracing::error!(
                                evt_seq = event.seq,
                                %detail,
                                "teardown is discarding malformed UI_CLOSED_DONE"
                            );
                            return true;
                        }
                    };
                    if !sink(UiPumpNotification::CloseDone { completion, window }) {
                        tracing::error!(
                            evt_seq = event.seq,
                            "teardown could not enqueue final plugin UI close completion"
                        );
                    }
                }
                kind => tracing::error!(
                    evt_seq = event.seq,
                    kind,
                    "teardown is discarding an unknown plugin UI event"
                ),
            }
            true
        })?;
        if let Some(pending) = state.pending_safepoint.take() {
            tracing::error!(
                generation = state.generation,
                evt_seq = pending.evt_seq,
                window = ?pending.window,
                "teardown failed a plugin UI safepoint waiter that was not present in the ring"
            );
        }
        for window in state.windows.values_mut() {
            window.lifecycle = UiLifecycle::Closed;
        }
        Ok(outcome)
    }
}

pub(super) fn remove_settled_window(state: &mut UiPumpState, window: UiWindowKey) {
    let settled = state.windows.get(&window).is_some_and(|window| {
        window.lifecycle == UiLifecycle::Closed && window.abandoned_safepoint.is_none()
    });
    if settled {
        state.windows.remove(&window);
    }
}

/// A blocked safepoint may be abandoned only when the immediately following event is the child's
/// explicit `timeout-without-save` completion. The caller owns a live mapping for `region`.
pub(super) fn is_abandon_done_published(
    region: *mut SharedRegion,
    next_seq: u64,
    window: UiWindowKey,
) -> bool {
    let published = unsafe { (*region).evt_seq.read() };
    if published < next_seq {
        return false;
    }
    let index = evt_slot_index(next_seq);
    let next_kind = unsafe { (*region).evt_kind[index].load(Ordering::Relaxed) };
    let next_arg = unsafe { read_cstr_field(&(*region).evt_arg[index]) };
    next_kind == EVT_UI_CLOSED_DONE
        && decode_ui_closed_done_arg(next_arg)
            == Ok((window, UiCloseCompletion::TimedOutWithoutSave))
}

/// timeout で見捨てたコマンドが**実は成功していた**まま破棄される時に warning を残す。
///
/// UIH.3 が想定する大きな state（fsync が 5 秒を超えうる）では実際に起こる。無言で消すと、
/// ユーザーは保存失敗を見た後、正しく書き終えていた state が消えたことに気づけない。
///
/// # Safety
///
/// `region` は生存している mapping を指していること。本ファイルの他の生ポインタ関数
/// （[`service_command_mailbox`] / [`reset_child_starting`] 等）と同じ契約。
/// **素の `fn` にしない** — 呼び出し側に「このポインタの有効性は誰が保証するのか」を
/// 見せるのがこの crate の慣習で、その慣習だけがガードになっている。
pub(super) unsafe fn warn_if_abandoned_save_succeeded(
    region: *mut SharedRegion,
    in_flight: &InFlightCommand,
) {
    if !in_flight.abandoned || in_flight.kind != CMD_SAVE_STATE {
        return;
    }
    let Some(sidecar_path) = in_flight.sidecar_path.as_ref() else {
        return;
    };
    let ack = unsafe { (*region).cmd_ack_seq.load(Ordering::Acquire) };
    let result = unsafe { (*region).cmd_result.load(Ordering::Relaxed) };
    if ack == in_flight.seq && result == CMD_RESULT_OK {
        tracing::warn!(
            seq = in_flight.seq,
            path = %sidecar_path.display(),
            "discarding plugin state saved after mailbox timeout"
        );
    }
}

pub(super) fn cleanup_abandoned_sidecar(
    in_flight: &InFlightCommand,
) -> Result<(), CommandMailboxError> {
    match in_flight.sidecar_path.as_deref() {
        Some(path) => remove_abandoned_sidecar(path),
        None => Ok(()),
    }
}

pub(super) fn remove_abandoned_sidecar(path: &Path) -> Result<(), CommandMailboxError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandMailboxError::SidecarCleanup {
            path: path.to_path_buf(),
            error,
        }),
    }
}
