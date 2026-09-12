//! エフェクト slot の型定義と環境変数の解析（#888 子 1・第 9 束）。
//!
//! 🔴 **これは純粋な移動である。** `engine_wrap.rs` の**モジュールレベル**にある
//! `OutProcControl` / `EffectSlotEntry` / `BusKind` 系の型と、
//! `ORBIT_*` 環境変数を読む関数群をそのまま移した。本文は 1 行も書き換えていない。
//!
//! 第 8 束と同じく、親と兄弟から名前で参照されるので `pub(super)` + 親側の `use` が要る
//! （`pub(super)` は可視性を上げるだけで名前をスコープへ持ち込まない）。

#[allow(unused_imports)]
use super::*;

/// out-of-process effect の control-side ハンドル一式（feature `outproc-effect` 専用）。
/// supervisor 本体（watchdog / child）は `StreamGuard::_child_guard` が保持する。ここは accessor が
/// 読む観測 stats だけを持つ（`ClapControl` と同様 read-path のハンドル）。
#[cfg(feature = "outproc-effect")]
pub(super) struct OutProcControl {
    /// 観測 stats（fresh/stale/stall/frames_clamped/callback_count/respawn/child error）。
    /// adapter（audio thread）と watchdog（control thread）が書き、accessor / gated harness が読む。
    pub(super) stats: Arc<crate::outproc_effect::OutProcEffectStats>,
    /// callback-duration 統計（A0 §6: CoreAudio+cpal は xrun 不発火 → RT 健全性は callback 実測時間で測る）。
    pub(super) cb_stats: Arc<orbit_audio_native::CallbackTimeStats>,
    /// post-boot attach の状態。`StreamGuard` と共有し、supervisor は stream より後に drop する。
    pub(super) child_slot: Weak<Mutex<ChildSlot>>,
    /// master effect slot の再構築と stream shutdown 交錯の制御に必要な固定部材。
    pub(super) master_entry: EffectSlotEntry,
    /// 起動時に固定した named insert bus の effect slots。master slot は `child_slot` のまま
    /// 保持し、bus 無し LoadPlugin の後方互換を保つ。
    pub(super) bus_slots: HashMap<String, Weak<Mutex<ChildSlot>>>,
    /// bus 名 → slot 再構築部材。`bus_slots` と同じキー集合を持つ。
    pub(super) bus_entries: HashMap<String, EffectSlotEntry>,
    /// bus 名 → その bus の `OutProcEffectStats`（`outproc_effect_bus_stats` gated 計測用）。
    /// `bus_slots` と同じキー集合で、child の生死に関わらず統計自体は生存し続けるため強参照。
    pub(super) bus_stats: HashMap<String, Arc<crate::outproc_effect::OutProcEffectStats>>,
    /// bus 名 → render 側 `InsertBusStage::active` と共有する activation flag。LoadPlugin が
    /// bus を指名した時点で `true`（宣言 = activation）。全 bus inactive の間、callback は
    /// bus 無し経路（ビット同一）を通る。
    pub(super) bus_actives: HashMap<String, Arc<std::sync::atomic::AtomicBool>>,
    /// bus 名 → kind（M2・#459/#453）。`SetBusRouting` の検証（output は sum のみ・send 先は
    /// aux のみ許可・MX.4）に使う。
    pub(super) bus_kinds: HashMap<String, BusKind>,
    /// bus 名 → stage 配列内の絶対 index（M2）。forward-only（後方参照のみ・MX.4）の検証に使う。
    pub(super) bus_index: HashMap<String, usize>,
    /// bus 名 → render 側 `InsertBusStage::routing_override` と共有する atomic ハンドル（M2）。
    /// `SetBusRouting` がここを書き換えて output target を実行時に切替える。
    pub(super) bus_routing: HashMap<String, Arc<AtomicUsize>>,
    /// bus 名 → render 側 `InsertBusStage::send_gain_overrides` と共有する atomic ハンドル群
    /// （M2・index k = 「この bus の絶対 index + 1 + k」への send gain）。
    pub(super) bus_sends: HashMap<String, Vec<Arc<AtomicU32>>>,
    /// 同じ固定 slot に対する差し替えを直列化する。`None` は master。
    pub(super) replacements_in_flight: HashSet<Option<String>>,
}

/// effect slot 1 本分の control-side 固定部材。in-place teardown 後も同じ shm と gate を使う。
#[cfg(feature = "outproc-effect")]
#[derive(Clone)]
pub(super) struct EffectSlotEntry {
    pub(super) shm_path: PathBuf,
    pub(super) child_exe: PathBuf,
    pub(super) sample_rate: u32,
    pub(super) engaged: Arc<AtomicBool>,
    pub(super) quiesce_requested: Arc<AtomicBool>,
    pub(super) quiesce_done: Arc<AtomicBool>,
    /// stream 停止が一度始まったことを示す control-side latch。false へ戻さない。
    pub(super) shutdown: Arc<AtomicBool>,
    /// Rack child の respawn と control command が共有する権威設定。RT は読まない。
    pub(super) chain: Arc<Mutex<crate::outproc_effect::ChainConfig>>,
}

/// RT adapter が保持する flags と control-side slot/teardown guard を一度だけ束ねる入力。
/// named fields にすることで同型 Arc の位置引数取り違えを構築側にも持ち込まない。
#[cfg(feature = "outproc-effect")]
pub(super) struct EffectSlotInstallParts {
    pub(super) shm_path: PathBuf,
    pub(super) child_exe: PathBuf,
    pub(super) sample_rate: u32,
    pub(super) stats: Arc<crate::outproc_effect::OutProcEffectStats>,
    pub(super) engaged: Arc<AtomicBool>,
    pub(super) quiesce_requested: Arc<AtomicBool>,
    pub(super) quiesce_done: Arc<AtomicBool>,
}

#[cfg(feature = "outproc-effect")]
pub(super) struct InstalledEffectSlot {
    pub(super) entry: EffectSlotEntry,
    pub(super) child_slot: Arc<Mutex<ChildSlot<EffectRole>>>,
    pub(super) teardown: crate::outproc_effect::OutProcTeardownGuard,
}

/// bus / effect-only master / combined master の3経路が共有する配線点。
/// entry・ChildLaunch・guard はここで同じ Arc から同時に構築される。
#[cfg(feature = "outproc-effect")]
pub(super) fn install_effect_slot(parts: EffectSlotInstallParts) -> InstalledEffectSlot {
    let shutdown = Arc::new(AtomicBool::new(false));
    let entry = EffectSlotEntry {
        shm_path: parts.shm_path.clone(),
        child_exe: parts.child_exe.clone(),
        sample_rate: parts.sample_rate,
        engaged: parts.engaged.clone(),
        quiesce_requested: parts.quiesce_requested.clone(),
        quiesce_done: parts.quiesce_done.clone(),
        shutdown: shutdown.clone(),
        chain: Arc::new(Mutex::new(Vec::new())),
    };
    let child_slot = Arc::new(Mutex::new(ChildSlot::Empty(ChildLaunch::<EffectRole> {
        shm_path: parts.shm_path,
        child_exe: parts.child_exe,
        sample_rate: parts.sample_rate,
        stats: parts.stats,
        engaged: parts.engaged,
        cleanup_shm_on_drop: true,
    })));
    let teardown = crate::outproc_effect::OutProcTeardownGuard::new(
        crate::outproc_effect::OutProcTeardownParts {
            requested: parts.quiesce_requested,
            done: parts.quiesce_done,
            shutdown,
        },
    );
    InstalledEffectSlot {
        entry,
        child_slot,
        teardown,
    }
}

#[cfg(feature = "outproc-effect")]
pub(super) struct EffectReplacementReservation<'a> {
    pub(super) engine: &'a EngineWrap,
    pub(super) target: Option<String>,
    pub(super) in_flight: bool,
}

#[cfg(feature = "outproc-effect")]
impl<'a> EffectReplacementReservation<'a> {
    pub(super) fn new(engine: &'a EngineWrap, target: Option<String>) -> Self {
        Self {
            engine,
            target,
            in_flight: false,
        }
    }

    pub(super) fn mark_in_flight(&mut self) {
        self.in_flight = true;
    }
}

#[cfg(feature = "outproc-effect")]
impl Drop for EffectReplacementReservation<'_> {
    fn drop(&mut self) {
        if !self.in_flight {
            return;
        }
        let mut guard = match self.engine.outproc.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::error!(
                    bus = ?self.target,
                    "effect control poisoned while releasing replacement reservation"
                );
                poisoned.into_inner()
            }
        };
        let Some(control) = guard.as_mut() else {
            tracing::error!(
                bus = ?self.target,
                "effect control missing while releasing replacement reservation"
            );
            return;
        };
        control.replacements_in_flight.remove(&self.target);
    }
}

#[cfg(feature = "outproc-effect")]
pub(super) type ResolvedOutProcEffectSlot = (
    Arc<Mutex<ChildSlot<EffectRole>>>,
    EffectSlotEntry,
    Arc<crate::outproc_effect::OutProcEffectStats>,
);

#[cfg(feature = "outproc-effect")]
pub(super) fn resolve_outproc_effect_slot(
    control: &OutProcControl,
    bus: &Option<String>,
) -> Result<ResolvedOutProcEffectSlot, WrapError> {
    if control.replacements_in_flight.contains(bus) {
        return Err(WrapError::OutProcEffect(format!(
            "effect replacement already in progress for {}",
            effect_slot_label(bus)
        )));
    }

    let (weak_slot, entry, stats) = match bus.as_ref() {
        Some(name) => (
            control.bus_slots.get(name).ok_or_else(|| {
                WrapError::OutProcEffect(format!(
                    "unknown effect bus '{name}' (configured by ORBIT_EFFECT_BUSES)"
                ))
            })?,
            control.bus_entries.get(name).cloned().ok_or_else(|| {
                WrapError::OutProcEffect(format!("effect bus '{name}' is missing its slot entry"))
            })?,
            control.bus_stats.get(name).cloned().ok_or_else(|| {
                WrapError::OutProcEffect(format!("effect bus '{name}' is missing its stats entry"))
            })?,
        ),
        None => (
            &control.child_slot,
            control.master_entry.clone(),
            control.stats.clone(),
        ),
    };
    if entry.shutdown.load(Ordering::Acquire) {
        return Err(WrapError::OutProcEffect("engine is stopping".into()));
    }
    let child_slot = weak_slot
        .upgrade()
        .ok_or_else(|| WrapError::OutProcEffect("outproc effect stream is closed".into()))?;
    Ok((child_slot, entry, stats))
}

#[cfg(all(test, feature = "outproc-effect"))]
pub(super) fn test_effect_slot_entry() -> EffectSlotEntry {
    EffectSlotEntry {
        shm_path: PathBuf::from("unused-effect-slot.shm"),
        child_exe: PathBuf::from("unused-effect-child"),
        sample_rate: 48_000,
        engaged: Arc::new(AtomicBool::new(false)),
        quiesce_requested: Arc::new(AtomicBool::new(false)),
        quiesce_done: Arc::new(AtomicBool::new(false)),
        shutdown: Arc::new(AtomicBool::new(false)),
        chain: Arc::new(Mutex::new(Vec::new())),
    }
}

/// `ORBIT_EFFECT_BUSES` の値を解析する純関数。カンマ区切りの bus 名を trim・空要素除去した上で、
/// 重複や NUL 文字を含む名前を拒否する。env 直読みを避けることで unit テスト可能にする
/// （`PluginFormat::from_env_value` / `parse_buffer_frames` と同じ「値渡し純関数 + env 読みラッパー」
/// の慣習に合わせる）。
#[cfg(feature = "outproc-effect")]
pub(super) fn parse_effect_buses(raw: &str) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    raw.split(',')
        .filter_map(|s| {
            let s = s.trim();
            (!s.is_empty()).then(|| s.to_owned())
        })
        .map(|bus| {
            if bus.contains('\0') || !seen.insert(bus.clone()) {
                Err(format!(
                    "ORBIT_EFFECT_BUSES contains duplicate or invalid bus '{bus}'"
                ))
            } else {
                Ok(bus)
            }
        })
        .collect()
}

/// 既定 insert bus プールの名前 prefix。DSL 側（TS）の per-sequence effect manager が
/// 同じ規則（`seq-bus-<n>`）で bus 名を組み立てて `LoadPlugin.bus` / `PlayAt.bus` に
/// 送るため、prefix を変える場合は TS 側の定数も合わせて更新すること（#434 S3）。
#[cfg(feature = "outproc-effect")]
pub const DEFAULT_EFFECT_BUS_POOL_PREFIX: &str = "seq-bus-";

/// `ORBIT_EFFECT_BUS_POOL` の既定サイズ（未設定時）。PH.2b の v1 上限（同時 insert 8 seq）と一致。
#[cfg(feature = "outproc-effect")]
pub(super) const DEFAULT_EFFECT_BUS_POOL_SIZE: usize = 8;

/// 既定プール名 `seq-bus-0..N` を生成する純関数。`ORBIT_EFFECT_BUSES`（明示名）が指定されて
/// いない場合のみ呼ばれる。`pool_size` は `ORBIT_EFFECT_BUS_POOL` の解析結果（既定 8・0 で無効）。
#[cfg(feature = "outproc-effect")]
pub(super) fn default_effect_bus_pool(pool_size: usize) -> Vec<String> {
    (0..pool_size)
        .map(|n| format!("{DEFAULT_EFFECT_BUS_POOL_PREFIX}{n}"))
        .collect()
}

/// `ORBIT_EFFECT_BUS_POOL` を解析する純関数。空 / 未設定は既定値（8）。`"0"` はプール無効
/// （明示的な `ORBIT_EFFECT_BUSES` のみ使う後方互換モード）。非数値・負値は起動時エラー。
#[cfg(feature = "outproc-effect")]
pub(super) fn parse_effect_bus_pool_size(raw: &str) -> Result<usize, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(DEFAULT_EFFECT_BUS_POOL_SIZE);
    }
    trimmed
        .parse::<usize>()
        .map_err(|_| format!("ORBIT_EFFECT_BUS_POOL must be a non-negative integer, got '{raw}'"))
}

/// bus 名の解決: `ORBIT_EFFECT_BUSES`（明示名・非空）が設定されていればそれを使う（既存 S2 挙動を
/// 保つ）。未設定なら `ORBIT_EFFECT_BUS_POOL`（既定 8・`"0"` で無効）に従って `seq-bus-<n>` の
/// 既定プールを生成する。両方指定は `ORBIT_EFFECT_BUSES` を優先（明示指定が常に勝つ）。
#[cfg(feature = "outproc-effect")]
pub(super) fn effect_buses_from_env() -> Result<Vec<String>, WrapError> {
    let explicit = std::env::var("ORBIT_EFFECT_BUSES").unwrap_or_default();
    if !explicit.trim().is_empty() {
        return parse_effect_buses(&explicit).map_err(WrapError::OutProcEffect);
    }
    let pool_raw = std::env::var("ORBIT_EFFECT_BUS_POOL").unwrap_or_default();
    let pool_size = parse_effect_bus_pool_size(&pool_raw).map_err(WrapError::OutProcEffect)?;
    Ok(default_effect_bus_pool(pool_size))
}

/// bus のグラフ上の役割（#459/#453 M2）。`insert` = 既存の per-seq effect bus（PH.2b・#434）・
/// `sum` = 複数 insert の合流点（`seq.output(sum)`）・`aux` = post-fader send 先（`seq.send(aux, gain)`）。
/// 名前 prefix（`seq-bus-`/`sum-bus-`/`aux-bus-`）からも判別できるが、`SetBusRouting` の検証
/// （output は sum のみ・send 先は aux のみ許可・MX.4）を prefix 文字列比較に依存させないため、
/// 構築時に確定した値として明示的に持つ。
#[cfg(feature = "outproc-effect")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BusKind {
    Insert,
    Sum,
    Aux,
}

/// `SetBusLine` の wire vocabulary。JSON shape の検証は session 層、名前から RT index への
/// 解決は topology を所有する EngineWrap が担う。
#[cfg(feature = "outproc-effect")]
#[derive(Debug, Clone, PartialEq)]
pub enum BusLineDest {
    Master,
    Bus(String),
    Device { left: usize, right: Option<usize> },
    Render(String),
    Link(String),
}

#[cfg(feature = "outproc-effect")]
#[derive(Debug, Clone, PartialEq)]
pub enum BusLineOp {
    Rack,
    Gain(f32),
    Pan(f32),
    Output {
        dest: BusLineDest,
        thru: bool,
        gain: f32,
    },
}

/// Explicit control-plane destination for one instrument source unit (#883 wire contract).
#[cfg(any(test, all(feature = "outproc-effect", feature = "outproc-instrument")))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceRoutingTarget {
    None,
    Master,
    Bus(String),
}

/// master ラインの shadow 初期値。
///
/// 🔴 **`MasterLine::new` が RT へ install する program と同じ 1 関数から作る**
/// （`default_master_line_ops` の doc を参照）。ここでリテラルを写していたときは、
/// 1ch デバイスで `dest.right` が実体（`Some(1)` 固定）と食い違い、seed の Output 照合が
/// 外れて既定 0.0 に落ちていた（`/code:pr-review-team` silent-failure-hunter・2026-09-11）。
/// バス側で `legacy_line_ops` に統一したのと同じ手当てを master にも当てる。
#[cfg(feature = "outproc-effect")]
pub(super) fn default_master_line_program(output_channels: u16) -> Vec<LineOp> {
    default_master_line_ops(output_channels)
}

/// バスが実際に走らせている初期 program。
///
/// 🔴 **手で同じ列を書き直さない**（`/simplify` の reuse / altitude が独立に同じ指摘・2026-09-11）。
/// RT へ渡る初期値は `InsertBusStage` が共有する `default_bus_line_ops()` の `[Rack]` そのもの。
/// ここでリテラルを写すと、native 側の既定だけが変わった
/// 時に **shadow だけが旧い形のまま残り、未設定バスへの最初の `SetBusLine` が誤った seed から
/// republish する** — 下の `initial_bus_line_shadows` のコメントが「exactly one place」と
/// 約束しているのは、まさにこれを防ぐため。
#[cfg(feature = "outproc-effect")]
pub(super) fn default_bus_line_program() -> Vec<LineOp> {
    default_bus_line_ops()
}

/// Every bus starts at the default program, so its republish shadow starts there too.
///
/// 🔴 The shadow is what a later `SetBusLine` seeds effective gains from. If it disagreed with
/// what the bus is actually running, seeding would restore the wrong value and reintroduce the
/// jump it exists to prevent — so build it in exactly one place.
#[cfg(feature = "outproc-effect")]
pub(super) fn initial_bus_line_shadows(
    bus_line_programs: &HashMap<String, LineProgramInstaller>,
) -> HashMap<String, Vec<LineOp>> {
    bus_line_programs
        .keys()
        .cloned()
        .map(|name| (name, default_bus_line_program()))
        .collect()
}

#[cfg(feature = "outproc-effect")]
pub(super) fn line_republish_seeds(
    new_ops: &[LineOp],
    old_ops: &[LineOp],
    old_current: &[f32],
) -> Vec<f32> {
    pub(super) fn same_key(left: &LineOp, right: &LineOp) -> bool {
        match (left, right) {
            (LineOp::Gain(_), LineOp::Gain(_)) | (LineOp::Pan(_), LineOp::Pan(_)) => true,
            (LineOp::Output(left), LineOp::Output(right)) => left.dest == right.dest,
            _ => false,
        }
    }

    new_ops
        .iter()
        .enumerate()
        .map(|(new_index, op)| {
            let ordinal = new_ops[..new_index]
                .iter()
                .filter(|candidate| same_key(candidate, op))
                .count();
            let inherited = old_ops
                .iter()
                .enumerate()
                .filter(|(_, candidate)| same_key(candidate, op))
                .nth(ordinal)
                .and_then(|(old_index, _)| old_current.get(old_index))
                .copied();
            inherited.unwrap_or(match op {
                LineOp::Rack | LineOp::Gain(_) => 1.0,
                LineOp::Pan(target) => *target,
                LineOp::Output(_) => 0.0,
            })
        })
        .collect()
}

/// `sum-bus-<n>` 既定プールの名前 prefix。TS 側 `seq.output(sum)` が同じ規則で名前を組み立てる
/// （M3 で配線予定）。
#[cfg(feature = "outproc-effect")]
pub const DEFAULT_SUM_BUS_POOL_PREFIX: &str = "sum-bus-";
/// `aux-bus-<n>` 既定プールの名前 prefix。TS 側 `seq.send(aux, gain)` が同じ規則で名前を組み立てる
/// （M3 で配線予定）。
#[cfg(feature = "outproc-effect")]
pub const DEFAULT_AUX_BUS_POOL_PREFIX: &str = "aux-bus-";
/// `ORBIT_SUM_BUS_POOL` の既定サイズ（未設定時）。
#[cfg(feature = "outproc-effect")]
pub(super) const DEFAULT_SUM_BUS_POOL_SIZE: usize = 4;
/// `ORBIT_AUX_BUS_POOL` の既定サイズ（未設定時）。
#[cfg(feature = "outproc-effect")]
pub(super) const DEFAULT_AUX_BUS_POOL_SIZE: usize = 4;

/// `ORBIT_SUM_BUS_POOL` / `ORBIT_AUX_BUS_POOL` に共通のプールサイズ解析（`parse_effect_bus_pool_size`
/// と同じ規則: 空 = 既定値・非数値/負値はエラー）。env 名をメッセージに含めるため呼び出し側が
/// 渡す（`ORBIT_EFFECT_BUS_POOL` 用の既存関数と重複させない）。
#[cfg(feature = "outproc-effect")]
pub(super) fn parse_named_bus_pool_size(
    env_name: &str,
    raw: &str,
    default: usize,
) -> Result<usize, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(default);
    }
    trimmed
        .parse::<usize>()
        .map_err(|_| format!("{env_name} must be a non-negative integer, got '{raw}'"))
}

/// `ORBIT_SUM_BUS_POOL`（既定 4）から `sum-bus-0..N-1` の既定プール名を組み立てる。
#[cfg(feature = "outproc-effect")]
pub(super) fn sum_bus_pool_from_env() -> Result<Vec<String>, WrapError> {
    named_bus_pool_from_env(
        "ORBIT_SUM_BUS_POOL",
        DEFAULT_SUM_BUS_POOL_SIZE,
        DEFAULT_SUM_BUS_POOL_PREFIX,
    )
}

/// `ORBIT_AUX_BUS_POOL`（既定 4）から `aux-bus-0..N-1` の既定プール名を組み立てる。
#[cfg(feature = "outproc-effect")]
pub(super) fn aux_bus_pool_from_env() -> Result<Vec<String>, WrapError> {
    named_bus_pool_from_env(
        "ORBIT_AUX_BUS_POOL",
        DEFAULT_AUX_BUS_POOL_SIZE,
        DEFAULT_AUX_BUS_POOL_PREFIX,
    )
}

/// env 名 + 既定サイズ + prefix から `<prefix>0..N-1` の既定プール名を組み立てる共通体
/// （/simplify: sum/aux の同一実装を単一化・命名スキーム変更時のドリフト防止）。
#[cfg(feature = "outproc-effect")]
pub(super) fn named_bus_pool_from_env(
    env_name: &str,
    default_size: usize,
    prefix: &str,
) -> Result<Vec<String>, WrapError> {
    let raw = std::env::var(env_name).unwrap_or_default();
    let n = parse_named_bus_pool_size(env_name, &raw, default_size)
        .map_err(WrapError::OutProcEffect)?;
    Ok((0..n).map(|i| format!("{prefix}{i}")).collect())
}

/// 1 本の named bus stage（insert/sum/aux 共通）を構成する部材（`build_effect_bus_stages` →
/// `install_effect_bus_slots` の間で運ぶ・#434 S2/S3・M2 で kind/routing を追加）。
/// effect-only / both の両起動経路で同一のライフサイクルを共有する。
#[cfg(feature = "outproc-effect")]
pub(super) struct EffectBusBuild {
    pub(super) name: String,
    pub(super) kind: BusKind,
    pub(super) shm_path: std::path::PathBuf,
    pub(super) engaged: Arc<std::sync::atomic::AtomicBool>,
    pub(super) stop: Arc<std::sync::atomic::AtomicBool>,
    pub(super) done: Arc<std::sync::atomic::AtomicBool>,
    pub(super) stats: Arc<crate::outproc_effect::OutProcEffectStats>,
    /// render 側 `InsertBusStage::active` と共有。LoadPlugin が bus を指名した時点で
    /// `true`（宣言 = activation → 以降 pass-through）。それまで callback は bus を
    /// render 対象に含めない = 既定プールのコストゼロ。
    pub(super) active: Arc<std::sync::atomic::AtomicBool>,
    /// render 側 `InsertBusStage::routing_override` と共有（M2）。`SetBusRouting` が
    /// control 側からこの Arc を書き換えて実行時に output target を切替える。
    pub(super) routing_override: Arc<AtomicUsize>,
    /// render 側 `InsertBusStage::send_gain_overrides` と共有（M2・index k = 「この stage の
    /// 絶対 index + 1 + k」への send gain）。`SetBusRouting` が該当 index の Arc を書き換える。
    pub(super) send_gain_overrides: Vec<Arc<AtomicU32>>,
}

#[cfg(feature = "outproc-effect")]
pub(super) type EffectBusStagesBuild = (
    Vec<orbit_audio_native::InsertBusStage>,
    Vec<EffectBusBuild>,
    HashMap<String, LegacyLineInstaller>,
    HashMap<String, LineProgramInstaller>,
);
