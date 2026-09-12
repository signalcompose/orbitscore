//! wire に載る公開型（#888 子 1・第 12 束＝最終）。
//!
//! 🔴 **これは純粋な移動である。** `LoadedPluginSummary` / `PluginUiTarget` /
//! `PluginUiEvent` などの**公開型**をそのまま移した。**本文は 1 行も書き換えていない。**
//! 公開型は `pub` のまま。`from_state_target` / `matches_state_target` / `short_uuid` は
//! 親・兄弟から呼ばれるので `pub(super)` にした（設計 §5 の **E3′** / §14）。
//!
//! これらは `session.rs` ほかクレート内の各所と、`main.rs` から名前で参照されるので
//! **`pub` のまま**にし、親から `pub use` で再エクスポートする。

#[allow(unused_imports)]
use super::*;

/// `load_plugin` の結果サマリ（feature 非依存型・session.rs を feature 非依存に保つ）。
/// feature 有効時は `orbit_clap_host::LoadedPluginInfo` から変換、無効時は stub が Err を返す。
#[derive(Debug)]
pub struct LoadedPluginSummary {
    pub plugin_id: String,
    pub plugin_name: Option<String>,
    pub note_port_index: u16,
}

#[derive(Debug)]
pub struct ReplacedPluginSummary {
    pub plugin: LoadedPluginSummary,
    pub quarantined_slot: bool,
}

#[derive(Debug)]
pub struct DroppedEffectStageSummary {
    pub prev_index: usize,
    pub path: PathBuf,
    pub bytes_written: u64,
}

#[derive(Debug)]
pub struct AppliedEffectChainSummary {
    pub child_pid: u32,
    pub dropped: Vec<DroppedEffectStageSummary>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnloadedPluginStatus {
    Unloaded,
    Noop,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginStateTarget {
    #[cfg(feature = "outproc-effect")]
    Effect { bus: Option<String> },
    #[cfg(feature = "outproc-instrument")]
    Instrument { instance: String },
}

/// WS event frame に載せる、解決済み plugin UI 宛先。
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
pub struct PluginUiTarget {
    pub role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bus: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    /// Immutable open token used for event attribution. `index` below is the open-time position
    /// retained only for display/diagnostics and must never be used as an ownership key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<u64>,
    pub index: u64,
}

impl PluginUiTarget {
    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub(super) fn from_state_target(
        target: &PluginStateTarget,
        index: u64,
        window: orbit_audio_sandbox::UiWindowKey,
    ) -> Self {
        match target {
            #[cfg(feature = "outproc-effect")]
            PluginStateTarget::Effect { bus } => Self {
                role: "effect",
                bus: bus.clone(),
                instance: None,
                window,
                index,
            },
            #[cfg(feature = "outproc-instrument")]
            PluginStateTarget::Instrument { instance } => Self {
                role: "instrument",
                bus: None,
                instance: Some(instance.clone()),
                window,
                index,
            },
        }
    }

    #[cfg(any(feature = "outproc-effect", feature = "outproc-instrument"))]
    pub(super) fn matches_state_target(&self, target: &PluginStateTarget) -> bool {
        match target {
            #[cfg(feature = "outproc-effect")]
            PluginStateTarget::Effect { bus } => {
                self.role == "effect" && self.bus == *bus && self.instance.is_none()
            }
            #[cfg(feature = "outproc-instrument")]
            PluginStateTarget::Instrument { instance } => {
                self.role == "instrument"
                    && self.instance.as_ref() == Some(instance)
                    && self.bus.is_none()
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginUiCompletion {
    SafepointCompleted,
    TimedOutWithoutSave,
}

impl PluginUiCompletion {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SafepointCompleted => "safepoint-completed",
            Self::TimedOutWithoutSave => "timeout-without-save",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginUiEvent {
    Closed {
        target: PluginUiTarget,
        generation: u64,
        evt_seq: u64,
    },
    CloseDone {
        target: PluginUiTarget,
        completion: PluginUiCompletion,
    },
    ClosedByRespawn {
        target: PluginUiTarget,
    },
}

#[cfg(all(test, any(feature = "outproc-effect", feature = "outproc-instrument")))]
mod plugin_ui_event_routing_tests {
    use super::*;

    fn target() -> PluginUiTarget {
        PluginUiTarget {
            role: "effect",
            bus: Some("lead".into()),
            instance: None,
            window: None,
            index: 2,
        }
    }

    fn route(window: orbit_audio_sandbox::UiWindowKey, index: u64) -> PluginUiTarget {
        PluginUiTarget {
            window,
            index,
            ..target()
        }
    }

    #[test]
    fn close_completion_is_emitted_only_for_the_done_notification() {
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let (events, mut receiver) = tokio::sync::broadcast::channel(4);

        assert!(enqueue_plugin_ui_notification(
            &route,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::Safepoint {
                generation: 3,
                evt_seq: 5,
                window: None,
            },
        ));
        assert_eq!(
            route.lock().expect("route lock").get(&None),
            Some(&target())
        );
        assert_eq!(
            receiver.try_recv().expect("safepoint event"),
            PluginUiEvent::Closed {
                target: target(),
                generation: 3,
                evt_seq: 5,
            }
        );
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        assert!(enqueue_plugin_ui_notification(
            &route,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::CloseDone {
                completion: orbit_audio_sandbox::UiCloseCompletion::SafepointCompleted,
                window: None,
            },
        ));
        assert_eq!(
            receiver.try_recv().expect("DONE event"),
            PluginUiEvent::CloseDone {
                target: target(),
                completion: PluginUiCompletion::SafepointCompleted,
            }
        );
        assert!(route.lock().expect("route lock").is_empty());
    }

    #[test]
    fn undelivered_safepoint_is_retried_on_every_pump_tick() {
        let shm = std::env::temp_dir().join(format!(
            "orbit-ui-undelivered-safepoint-{}-{}.shm",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let mmap = orbit_audio_sandbox::create_shared(&shm).expect("create shared region");
        let region = orbit_audio_sandbox::region_ptr(&mmap);
        let mut child = orbit_audio_sandbox::transport::EventRingChild::new();
        child
            .queue(orbit_audio_sandbox::transport::EVT_UI_CLOSED, "")
            .expect("queue UI_CLOSED");
        unsafe { child.service(region) }.expect("publish UI_CLOSED");

        let pump = orbit_audio_sandbox::UiEventPump::new(shm.clone());
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let (events, receiver) = tokio::sync::broadcast::channel(1);
        drop(receiver);
        let mut attempts = 0;

        for _ in 0..3 {
            let outcome = pump
                .poll_step(|notification| {
                    attempts += 1;
                    enqueue_plugin_ui_notification(&route, None, &events, notification)
                })
                .expect("poll undelivered safepoint");
            assert!(matches!(
                outcome,
                orbit_audio_sandbox::transport::EventPollOutcome::Blocked { seq: 1, .. }
            ));
        }

        assert_eq!(attempts, 3, "delivery must be retried on every tick");
        assert_eq!(unsafe { (*region).evt_ack_seq.read() }, 0);
        assert_eq!(
            route.lock().expect("route lock").get(&None),
            Some(&target())
        );

        drop(mmap);
        std::fs::remove_file(shm).expect("remove shared region");
    }

    #[test]
    fn undelivered_close_done_is_consumed_after_taking_its_route() {
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let (events, receiver) = tokio::sync::broadcast::channel(1);
        drop(receiver);

        assert!(enqueue_plugin_ui_notification(
            &route,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::CloseDone {
                completion: orbit_audio_sandbox::UiCloseCompletion::SafepointCompleted,
                window: None,
            },
        ));
        assert!(route.lock().expect("route lock").is_empty());
    }

    #[test]
    fn contended_target_lock_retries_notification() {
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let (events, mut receiver) = tokio::sync::broadcast::channel(1);
        let guard = route.lock().expect("hold route lock");

        assert!(!enqueue_plugin_ui_notification(
            &route,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::Safepoint {
                generation: 3,
                evt_seq: 5,
                window: None,
            },
        ));
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
        drop(guard);
        assert_eq!(
            route.lock().expect("route lock").get(&None),
            Some(&target())
        );
    }

    #[test]
    fn poisoned_target_lock_still_routes_notification() {
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let poison_route = route.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poison_route.lock().expect("lock before poison");
            panic!("poison plugin UI target lock");
        })
        .join();
        assert!(route.is_poisoned());
        let (events, mut receiver) = tokio::sync::broadcast::channel(1);

        assert!(enqueue_plugin_ui_notification(
            &route,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::Safepoint {
                generation: 3,
                evt_seq: 5,
                window: None,
            },
        ));
        assert_eq!(
            receiver.try_recv().expect("event from poisoned route"),
            PluginUiEvent::Closed {
                target: target(),
                generation: 3,
                evt_seq: 5,
            }
        );
    }

    #[test]
    fn respawn_event_is_loud_and_consumes_the_visible_route() {
        let route = Arc::new(Mutex::new(BTreeMap::from([(None, target())])));
        let (events, mut receiver) = tokio::sync::broadcast::channel(1);
        enqueue_plugin_ui_closed_by_respawn(&route, None, &[None], &events);

        assert_eq!(
            receiver.try_recv().expect("respawn event"),
            PluginUiEvent::ClosedByRespawn { target: target() }
        );
        assert!(route.lock().expect("route lock").is_empty());
    }

    #[test]
    fn w1_close_done_removes_only_its_window_route() {
        let w1 = Some(11);
        let w2 = Some(22);
        let t1 = route(w1, 0);
        let t2 = route(w2, 2);
        let routes = Mutex::new(BTreeMap::from([(w1, t1.clone()), (w2, t2.clone())]));
        let binding = Mutex::new(BTreeMap::from([(0, 11), (2, 22)]));
        let (events, mut receiver) = tokio::sync::broadcast::channel(2);

        assert!(enqueue_plugin_ui_notification(
            &routes,
            Some(&binding),
            &events,
            orbit_audio_sandbox::UiPumpNotification::CloseDone {
                completion: orbit_audio_sandbox::UiCloseCompletion::SafepointCompleted,
                window: w2,
            },
        ));

        assert_eq!(
            receiver.try_recv().expect("w2 completion"),
            PluginUiEvent::CloseDone {
                target: t2,
                completion: PluginUiCompletion::SafepointCompleted,
            }
        );
        assert_eq!(*routes.lock().expect("routes"), BTreeMap::from([(w1, t1)]));
        assert_eq!(*binding.lock().expect("binding"), BTreeMap::from([(0, 11)]));
    }

    #[test]
    fn w2_safepoint_uses_the_notification_window_route() {
        // Make w2 the first BTreeMap entry so a "first route" regression cannot accidentally pass.
        let w1 = Some(22);
        let w2 = Some(11);
        let t1 = route(w1, 2);
        let routes = Mutex::new(BTreeMap::from([(w1, t1.clone()), (w2, route(w2, 0))]));
        let (events, mut receiver) = tokio::sync::broadcast::channel(2);

        assert!(enqueue_plugin_ui_notification(
            &routes,
            None,
            &events,
            orbit_audio_sandbox::UiPumpNotification::Safepoint {
                generation: 3,
                evt_seq: 5,
                window: w1,
            },
        ));

        assert_eq!(
            receiver.try_recv().expect("w1 safepoint"),
            PluginUiEvent::Closed {
                target: t1,
                generation: 3,
                evt_seq: 5,
            }
        );
    }

    #[test]
    fn w3_respawn_drains_every_route_and_binding() {
        let w1 = Some(11);
        let w2 = Some(22);
        let t1 = route(w1, 0);
        let t2 = route(w2, 2);
        let routes = Mutex::new(BTreeMap::from([(w1, t1.clone()), (w2, t2.clone())]));
        let binding = Mutex::new(BTreeMap::from([(0, 11), (2, 22)]));
        let (events, mut receiver) = tokio::sync::broadcast::channel(2);

        enqueue_plugin_ui_closed_by_respawn(&routes, Some(&binding), &[w1, w2], &events);

        let received = [
            receiver.try_recv().expect("first respawn event"),
            receiver.try_recv().expect("second respawn event"),
        ];
        assert_eq!(received.len(), 2);
        assert!(received.contains(&PluginUiEvent::ClosedByRespawn { target: t1 }));
        assert!(received.contains(&PluginUiEvent::ClosedByRespawn { target: t2 }));
        assert!(routes.lock().expect("routes").is_empty());
        assert!(binding.lock().expect("binding").is_empty());
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct SavedPluginStateSummary {
    pub path: PathBuf,
    pub bytes_written: u64,
}

pub struct PlayHandle {
    pub play_id: String,
    pub start_sec: f64,
    pub duration_sec: f64,
}

pub(super) fn short_uuid() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}
