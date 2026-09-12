//! host→child のコマンドメールボックス（ack 待ちとタイムアウト）（#888 子 3・orbit-audio-sandbox）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(super)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use super::*;

/// `cmd_result`: 成功。
pub const CMD_RESULT_OK: u32 = 0;
/// `cmd_result`: plugin が state を返さなかった（`getState` 失敗・非対応）。
pub const CMD_RESULT_PLUGIN_ERROR: u32 = 1;
/// `cmd_result`: サイドカーファイルへの書き込みに失敗した。
pub const CMD_RESULT_IO_ERROR: u32 = 2;
/// `cmd_result`: `cmd_arg` が不正（空・非 UTF-8・NUL 終端なし）。
pub const CMD_RESULT_BAD_ARG: u32 = 3;
/// `cmd_result`: 未知の `cmd_kind`（**黙って無視せず ack で知らせる**）。
pub const CMD_RESULT_UNKNOWN_KIND: u32 = 4;
/// `cmd_result`: command の処理中に child が終了し、host が failure ack で打ち切った。
pub const CMD_RESULT_CHILD_EXITED: u32 = 5;

/// plugin state mailbox の ack 待ち上限（UIH.2 / #562）。
///
/// 上位層を含めてこの定数を唯一の production timeout として使う。テストだけは
/// [`CommandMailboxHost::issue_save_state_with_timeout`] へ短い値を渡して timeout 分岐を踏む。
pub const PLUGIN_STATE_MAILBOX_TIMEOUT: Duration = Duration::from_secs(5);
/// `APPLY_CHAIN` の完了 ack 待ち上限。
///
/// APPLY は単一 state 保存と違い、1 コマンド内で複数 plugin の同期 load を行う。重い plugin
/// の連続 load は通常の state mailbox 上限 5 秒を正当に超えうるため、専用の長い上限を持つ。
/// timeout 後も child は commit しうるので、上位層はこの失敗を registry uncertain と扱う。
pub const APPLY_CHAIN_MAILBOX_TIMEOUT: Duration = Duration::from_secs(60);
/// `OPEN_UI` の完了 ack 待ち上限。
///
/// `OPEN_UI` は受理時でなく plugin view の生成・host window への attach が完了してから ack する。
/// 重い plugin の `createView` は state mailbox の通常上限 5 秒を正当に超えうるため、UI open
/// だけは専用の余裕を持つ。close handshake の 10 秒 timeout とは別物であり、daemon 側の
/// safepoint timeout は追加しない。
pub const OPEN_UI_MAILBOX_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandMailboxResponse {
    pub bytes_written: u64,
    /// Command detail returned by the child. UIH.4c permits a successful no-op
    /// `CLOSE_UI` to carry `"already-closing"`.
    pub detail: String,
}

#[derive(Debug)]
pub enum CommandMailboxError {
    Mapping(io::Error),
    SidecarCleanup {
        path: PathBuf,
        error: io::Error,
    },
    InvalidArgument(String),
    Busy {
        seq: u64,
    },
    Poisoned {
        seq: u64,
    },
    Timeout {
        seq: u64,
        elapsed: Duration,
    },
    ChildExited {
        seq: u64,
        detail: String,
    },
    CommandFailed {
        seq: u64,
        result: u32,
        detail: String,
    },
    Protocol {
        seq: u64,
        ack: u64,
    },
    SequenceExhausted,
    CoordinatorPoisoned,
}

impl fmt::Display for CommandMailboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mapping(error) => write!(f, "plugin state mailbox mapping failed: {error}"),
            Self::SidecarCleanup { path, error } => write!(
                f,
                "abandoned sidecar cleanup failed: {}: {error}",
                path.display()
            ),
            Self::InvalidArgument(detail) => {
                write!(f, "invalid plugin state sidecar path: {detail}")
            }
            Self::Busy { seq } => {
                write!(f, "plugin state mailbox command {seq} is still in flight")
            }
            Self::Poisoned { seq } => write!(
                f,
                "plugin state mailbox command {seq} timed out and remains in flight"
            ),
            Self::Timeout { seq, elapsed } => write!(
                f,
                "plugin state mailbox command {seq} timed out after {elapsed:?}"
            ),
            Self::ChildExited { seq, detail } => {
                write!(
                    f,
                    "plugin child exited during mailbox command {seq}: {detail}"
                )
            }
            Self::CommandFailed {
                seq,
                result,
                detail,
            } => write!(
                f,
                "plugin state mailbox command {seq} failed (result={result}): {detail}"
            ),
            Self::Protocol { seq, ack } => write!(
                f,
                "plugin state mailbox ack mismatch: expected exactly {seq}, got {ack}"
            ),
            Self::SequenceExhausted => write!(f, "plugin state mailbox sequence exhausted"),
            Self::CoordinatorPoisoned => write!(f, "plugin state mailbox coordinator poisoned"),
        }
    }
}

impl std::error::Error for CommandMailboxError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Mapping(error) | Self::SidecarCleanup { error, .. } => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for CommandMailboxError {
    fn from(value: io::Error) -> Self {
        Self::Mapping(value)
    }
}

#[derive(Debug)]
pub(super) struct InFlightCommand {
    pub(super) seq: u64,
    /// 投函時の [`CommandMailboxState::generation`]。ack 照合で `seq` と**併せて**見る。
    ///
    /// 「`seq` だけで足りるのでは」は正しい問いで、**現状の実装では実際に足りている** —
    /// [`reset_child_starting`] は `cmd_seq` をゼロに戻さず `cmd_ack_seq` を追いつかせるだけなので、
    /// `cmd_seq` は child の世代をまたいで単調増加し、同じ `seq` が二度使われない。
    ///
    /// それでも残すのは、**その単調性が共有メモリ側のリセット手順に依存している**から。
    /// respawn 時に「綺麗な状態から始める」意図で `cmd_seq` を 0 に戻す変更を入れると、
    /// 旧世代の待機スレッドが新世代の同番コマンドを自分のものと誤認して in-flight を
    /// 消しにいく（= 別コマンドの ack を横取りする）。generation を見ていればその変更は
    /// 安全側に倒れる。フィールド 2 本と `&&` 3 箇所の対価としては安い。
    pub(super) generation: u64,
    pub(super) abandoned: bool,
    pub(super) kind: u32,
    pub(super) sidecar_path: Option<std::path::PathBuf>,
}

#[derive(Debug, Default)]
pub(super) struct CommandMailboxState {
    pub(super) generation: u64,
    pub(super) in_flight: Option<InFlightCommand>,
}

/// host 側の single-outstanding command coordinator（UIH.2 / #562）。
///
/// `Mutex` は投函と reset の短い critical section だけを保護する。ack 待ち中は保持しないため、
/// watchdog は child 死亡後に in-flight command を failure ack で完了させられる。
#[derive(Debug)]
pub struct CommandMailboxHost {
    pub(super) shm_path: std::path::PathBuf,
    pub(super) state: Mutex<CommandMailboxState>,
}

impl CommandMailboxHost {
    pub fn new(shm_path: std::path::PathBuf) -> Self {
        Self {
            shm_path,
            state: Mutex::new(CommandMailboxState::default()),
        }
    }

    pub fn issue_save_state(
        &self,
        sidecar_path: &Path,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        self.issue_save_state_with_timeout(sidecar_path, PLUGIN_STATE_MAILBOX_TIMEOUT)
    }

    pub fn issue_open_ui(
        &self,
        window_title: &str,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        self.issue_command(CMD_OPEN_UI, window_title, None, OPEN_UI_MAILBOX_TIMEOUT)
    }

    pub fn issue_close_ui(&self) -> Result<CommandMailboxResponse, CommandMailboxError> {
        self.issue_command(CMD_CLOSE_UI, "", None, PLUGIN_STATE_MAILBOX_TIMEOUT)
    }

    /// Apply a complete effect-rack plan prepared by the daemon.
    pub fn issue_apply_chain(
        &self,
        plan_path: &Path,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        self.issue_apply_chain_with_timeout(plan_path, APPLY_CHAIN_MAILBOX_TIMEOUT)
    }

    /// `timeout` の差し替えは unit test が production の長い APPLY 上限を待たずに failure
    /// lifecycle を実証するための seam。production caller は必ず [`Self::issue_apply_chain`] を使う。
    #[doc(hidden)]
    pub fn issue_apply_chain_with_timeout(
        &self,
        plan_path: &Path,
        timeout: Duration,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        let path = plan_path.to_str().ok_or_else(|| {
            CommandMailboxError::InvalidArgument("plan path must be valid UTF-8".into())
        })?;
        self.issue_command(CMD_APPLY_CHAIN, path, None, timeout)
    }

    /// Save state for one flat rack stage.
    pub fn issue_save_state_at(
        &self,
        argument: &str,
        sidecar_path: &Path,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        if !sidecar_path.is_absolute() {
            return Err(CommandMailboxError::InvalidArgument(
                "path must be absolute".into(),
            ));
        }
        self.issue_command(
            CMD_SAVE_STATE_AT,
            argument,
            Some(sidecar_path),
            PLUGIN_STATE_MAILBOX_TIMEOUT,
        )
    }

    /// Open the UI belonging to one flat rack stage.
    pub fn issue_open_ui_at(
        &self,
        argument: &str,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        self.issue_command(CMD_OPEN_UI_AT, argument, None, OPEN_UI_MAILBOX_TIMEOUT)
    }

    /// Close the UI belonging to one flat rack stage.
    pub fn issue_close_ui_at(
        &self,
        argument: &str,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        self.issue_command(
            CMD_CLOSE_UI_AT,
            argument,
            None,
            PLUGIN_STATE_MAILBOX_TIMEOUT,
        )
    }

    /// 現在の child incarnation が plugin state 復元まで終えて READY かをAcquireで確認する。
    pub fn child_is_ready(&self) -> Result<bool, CommandMailboxError> {
        let mmap = open_shared(&self.shm_path)?;
        let region = region_ptr(&mmap);
        Ok(unsafe { (*region).child_status.load(Ordering::Acquire) } == CHILD_STATUS_READY)
    }

    /// `timeout` の差し替えは unit test が5秒待たずに failure lifecycle を実証するための seam。
    /// production caller は必ず [`Self::issue_save_state`] を使う。
    #[doc(hidden)]
    pub fn issue_save_state_with_timeout(
        &self,
        sidecar_path: &Path,
        timeout: Duration,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        if !sidecar_path.is_absolute() {
            return Err(CommandMailboxError::InvalidArgument(
                "path must be absolute".into(),
            ));
        }
        let sidecar = sidecar_path.to_str().ok_or_else(|| {
            CommandMailboxError::InvalidArgument("path must be valid UTF-8".into())
        })?;
        self.issue_command(CMD_SAVE_STATE, sidecar, Some(sidecar_path), timeout)
    }

    fn issue_command(
        &self,
        kind: u32,
        arg: &str,
        sidecar_path: Option<&Path>,
        timeout: Duration,
    ) -> Result<CommandMailboxResponse, CommandMailboxError> {
        let mmap = open_shared(&self.shm_path)?;
        let region = region_ptr(&mmap);
        let (seq, generation) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;

            if let Some(in_flight) = state.in_flight.as_ref() {
                if !in_flight.abandoned {
                    return Err(CommandMailboxError::Busy { seq: in_flight.seq });
                }
                let ack = unsafe { (*region).cmd_ack_seq.load(Ordering::Acquire) };
                if ack != in_flight.seq {
                    return Err(CommandMailboxError::Poisoned { seq: in_flight.seq });
                }
                // SAFETY: region はこのメソッドが open_shared で得た生存 mapping を指す。
                unsafe { warn_if_abandoned_save_succeeded(region, in_flight) };
                let cleanup_result = cleanup_abandoned_sidecar(in_flight);
                state.in_flight = None;
                cleanup_result?;
            }

            let previous = unsafe { (*region).cmd_seq.load(Ordering::Relaxed) };
            let seq = previous
                .checked_add(1)
                .ok_or(CommandMailboxError::SequenceExhausted)?;
            unsafe {
                if !write_cstr_field(&mut (*region).cmd_arg, arg) {
                    return Err(CommandMailboxError::InvalidArgument(format!(
                        "command argument must contain no NUL and fit in CMD_ARG_BYTES={CMD_ARG_BYTES}"
                    )));
                }
                let _ = write_cstr_field(&mut (*region).cmd_result_detail, "");
                (*region).cmd_result_len.store(0, Ordering::Relaxed);
                (*region).cmd_result.store(CMD_RESULT_OK, Ordering::Relaxed);
                (*region).cmd_kind.store(kind, Ordering::Relaxed);
                // Release publish: child は cmd_seq Acquire 後に kind/arg を読む。
                (*region).cmd_seq.store(seq, Ordering::Release);
            }
            let generation = state.generation;
            state.in_flight = Some(InFlightCommand {
                seq,
                generation,
                abandoned: false,
                kind,
                sidecar_path: sidecar_path.map(Path::to_path_buf),
            });
            (seq, generation)
        };

        let started = Instant::now();
        loop {
            {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;
                if state.generation != generation {
                    return Err(CommandMailboxError::ChildExited {
                        seq,
                        detail: "child died and the mailbox was reset before replacement spawn"
                            .into(),
                    });
                }
            }

            let ack = unsafe { (*region).cmd_ack_seq.load(Ordering::Acquire) };
            if ack == seq {
                let result = unsafe { (*region).cmd_result.load(Ordering::Relaxed) };
                let bytes_written = unsafe { (*region).cmd_result_len.load(Ordering::Relaxed) };
                let detail = unsafe {
                    read_cstr_field(&(*region).cmd_result_detail)
                        .unwrap_or("invalid UTF-8 in command detail")
                        .to_string()
                };
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;
                if matches!(
                    state.in_flight.as_ref(),
                    Some(current)
                        if current.seq == seq
                            && current.generation == generation
                ) {
                    state.in_flight = None;
                }
                return match result {
                    CMD_RESULT_OK => Ok(CommandMailboxResponse {
                        bytes_written,
                        detail,
                    }),
                    CMD_RESULT_CHILD_EXITED => {
                        Err(CommandMailboxError::ChildExited { seq, detail })
                    }
                    _ => Err(CommandMailboxError::CommandFailed {
                        seq,
                        result,
                        detail,
                    }),
                };
            }
            if ack > seq {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;
                if let Some(current) = state.in_flight.as_mut() {
                    if current.seq == seq && current.generation == generation {
                        current.abandoned = true;
                    }
                }
                return Err(CommandMailboxError::Protocol { seq, ack });
            }

            let elapsed = started.elapsed();
            if elapsed >= timeout {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;
                if let Some(current) = state.in_flight.as_mut() {
                    if current.seq == seq && current.generation == generation {
                        // timeout 後も delayed ack が来うる。ack/reset まで slot を再利用させない。
                        current.abandoned = true;
                    }
                }
                return Err(CommandMailboxError::Timeout { seq, elapsed });
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// watchdog が旧 child の死亡を確認した後、replacement spawn より前に呼ぶ。
    pub fn reset_after_child_exit(&self) -> Result<(), CommandMailboxError> {
        let mmap = open_shared(&self.shm_path)?;
        let region = region_ptr(&mmap);
        let mut state = self
            .state
            .lock()
            .map_err(|_| CommandMailboxError::CoordinatorPoisoned)?;
        if let Some(in_flight) = state.in_flight.as_ref() {
            // SAFETY: region はこのメソッドが open_shared で得た生存 mapping を指す。
            unsafe { warn_if_abandoned_save_succeeded(region, in_flight) };
        }
        // SAFETY: mmap は生存し、旧 child の死亡確認後なので child と reset writer は競合しない。
        unsafe { reset_child_starting(region) };
        state.generation = state.generation.wrapping_add(1);
        let cleanup_result = state
            .in_flight
            .as_ref()
            .map(cleanup_abandoned_sidecar)
            .unwrap_or(Ok(()));
        state.in_flight = None;
        cleanup_result
    }
}
