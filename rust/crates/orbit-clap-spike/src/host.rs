//! Headless CLAP host handlers (A0 §4.3).
//!
//! Ported from clack cpal example `host.rs` with GUI/timer/winit/midir stripped.
//! Headless-only: main-thread pump via `std::sync::mpsc::channel`.

use clack_extensions::audio_ports::{AudioPortRescanFlags, HostAudioPortsImpl};
use clack_extensions::log::{HostLog, HostLogImpl, LogSeverity};
use clack_extensions::note_ports::{HostNotePortsImpl, NoteDialects, NotePortRescanFlags};
use clack_extensions::params::{
    HostParams, HostParamsImplMainThread, HostParamsImplShared, ParamClearFlags, ParamRescanFlags,
};
use clack_host::prelude::*;
use std::sync::{
    mpsc::Sender,
    OnceLock,
};
use clack_extensions::audio_ports::PluginAudioPorts;

/// Messages that plugin threads send to the main thread.
pub enum MainThreadMessage {
    /// Plugin requested `call_on_main_thread_callback`.
    RunOnMainThread,
}

/// The host type tag — ties together Shared / MainThread / AudioProcessor.
pub struct OrbitClapHost;

impl HostHandlers for OrbitClapHost {
    type Shared<'a> = OrbitHostShared;
    type MainThread<'a> = OrbitHostMainThread<'a>;
    type AudioProcessor<'a> = ();

    fn declare_extensions(builder: &mut HostExtensions<Self>, _shared: &Self::Shared<'_>) {
        builder
            .register::<HostLog>()
            .register::<HostParams>();
        // Note: audio-ports and note-ports extensions are queried from the plugin,
        // they don't need to be registered as host-provided extensions here.
    }
}

/// Callbacks stored once during `initializing`.
#[allow(dead_code)]
struct PluginCallbacks {
    audio_ports: Option<PluginAudioPorts>,
}

/// Data accessible from any thread.
pub struct OrbitHostShared {
    sender: Sender<MainThreadMessage>,
    callbacks: OnceLock<PluginCallbacks>,
}

impl OrbitHostShared {
    pub fn new(sender: Sender<MainThreadMessage>) -> Self {
        Self {
            sender,
            callbacks: OnceLock::new(),
        }
    }
}

impl<'a> SharedHandler<'a> for OrbitHostShared {
    fn initializing(&self, instance: InitializingPluginHandle<'a>) {
        let _ = self.callbacks.set(PluginCallbacks {
            audio_ports: instance.get_extension(),
        });
    }

    fn request_restart(&self) {
        // S1: restart not supported
    }

    fn request_process(&self) {
        // CPAL is always processing; nothing to do
    }

    fn request_callback(&self) {
        let _ = self.sender.send(MainThreadMessage::RunOnMainThread);
    }
}

/// Data only accessible on the main thread.
pub struct OrbitHostMainThread<'a> {
    _shared: &'a OrbitHostShared,
    plugin: Option<InitializedPluginHandle<'a>>,
}

impl<'a> OrbitHostMainThread<'a> {
    pub fn new(shared: &'a OrbitHostShared) -> Self {
        Self {
            _shared: shared,
            plugin: None,
        }
    }
}

impl<'a> MainThreadHandler<'a> for OrbitHostMainThread<'a> {
    fn initialized(&mut self, instance: InitializedPluginHandle<'a>) {
        self.plugin = Some(instance);
    }
}

// ---- Extension implementations ------------------------------------------

impl HostLogImpl for OrbitHostShared {
    fn log(&self, severity: LogSeverity, message: &str) {
        if severity <= LogSeverity::Debug {
            return;
        }
        // Note: eprintln is not RT-safe; this is on the host log path which
        // plugins call from any thread. For a spike this is acceptable.
        eprintln!("[clap:{severity}] {message}");
    }
}

impl HostAudioPortsImpl for OrbitHostMainThread<'_> {
    fn is_rescan_flag_supported(&self, _flag: AudioPortRescanFlags) -> bool {
        false
    }

    fn rescan(&mut self, _flags: AudioPortRescanFlags) {
        // S1: no dynamic port changes
    }
}

impl HostNotePortsImpl for OrbitHostMainThread<'_> {
    fn supported_dialects(&self) -> NoteDialects {
        NoteDialects::CLAP
    }

    fn rescan(&mut self, _flags: NotePortRescanFlags) {
        // S1: no dynamic note port changes
    }
}

impl HostParamsImplMainThread for OrbitHostMainThread<'_> {
    fn rescan(&mut self, _flags: ParamRescanFlags) {}
    fn clear(&mut self, _param_id: ClapId, _flags: ParamClearFlags) {}
}

impl HostParamsImplShared for OrbitHostShared {
    fn request_flush(&self) {
        // Always processing; nothing to flush
    }
}

// ---- Note on headless pump -----------------------------------------------
// The pump runs inline on main() — PluginInstance<OrbitClapHost> is !Send,
// so it cannot be moved to a worker thread. The main thread uses
// mpsc::Receiver::recv_timeout to interleave pump + deadline check.
// See main.rs for the implementation.
