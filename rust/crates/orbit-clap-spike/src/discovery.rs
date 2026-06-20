//! Plugin discovery: load a .clap bundle by file path.
//!
//! Ported from clack cpal example `discovery.rs`, stripped of rayon/scan-by-id paths.
//! S1 uses `--file-path` direct load only (A0 §8: no dynamic hot-install in S1).

// Loading plugin bundles requires unsafe FFI.
#![allow(unsafe_code)]

use clack_host::entry::{LibraryEntry, PluginEntryError};
use clack_host::prelude::PluginEntry;
use std::ffi::CString;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

/// A located and loadable plugin.
pub struct FoundPlugin {
    /// Plugin descriptor.
    pub plugin: PluginDescriptor,
    /// The loaded entry (bundle).
    pub entry: PluginEntry,
    /// Source path (for display / error messages).
    #[allow(dead_code)]
    pub path: PathBuf,
}

/// Simplified (owned) plugin descriptor.
#[derive(Debug)]
pub struct PluginDescriptor {
    pub id: String,
    pub name: Option<String>,
    pub version: Option<String>,
}

impl PluginDescriptor {
    pub fn try_from(p: &clack_host::plugin::PluginDescriptor) -> Option<Self> {
        Some(Self {
            id: p.id()?.to_str().ok()?.to_string(),
            name: p.name().map(|v| v.to_string_lossy().to_string()),
            version: p.version().map(|v| v.to_string_lossy().to_string()),
        })
    }
}

impl Display for PluginDescriptor {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match (&self.name, &self.version) {
            (None, None) => write!(f, "{}", &self.id),
            (Some(n), None) => write!(f, "{n} ({})", &self.id),
            (None, Some(v)) => write!(f, "{} v{v}", &self.id),
            (Some(n), Some(v)) => write!(f, "{n} ({}) v{v}", &self.id),
        }
    }
}

/// Errors during discovery.
#[derive(Debug)]
pub enum DiscoveryError {
    LoadError(PluginEntryError),
    MissingPluginFactory,
    NullBundlePath,
}

impl From<PluginEntryError> for DiscoveryError {
    fn from(e: PluginEntryError) -> Self {
        Self::LoadError(e)
    }
}

impl Display for DiscoveryError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            DiscoveryError::LoadError(e) => write!(f, "Failed to load plugin file: {e}"),
            DiscoveryError::MissingPluginFactory => f.write_str("File has no plugin factory"),
            DiscoveryError::NullBundlePath => f.write_str("Bundle path contains null byte"),
        }
    }
}

impl std::error::Error for DiscoveryError {}

/// Load all plugins from a .clap bundle at `path`.
pub fn list_plugins_in_file(path: &Path) -> Result<Vec<FoundPlugin>, DiscoveryError> {
    let bundle_path =
        CString::new(path.to_string_lossy().as_bytes()).map_err(|_| DiscoveryError::NullBundlePath)?;

    // SAFETY: loading a native library is inherently unsafe.
    let library = unsafe { LibraryEntry::load_from_path(path) }?;
    let entry = unsafe { PluginEntry::load_from(library, &bundle_path) }?;

    let factory = entry
        .get_plugin_factory()
        .ok_or(DiscoveryError::MissingPluginFactory)?;

    Ok(factory
        .plugin_descriptors()
        .filter_map(|p| PluginDescriptor::try_from(p))
        .map(|plugin| FoundPlugin {
            entry: entry.clone(),
            path: path.to_path_buf(),
            plugin,
        })
        .collect())
}

/// Load a specific plugin by ID from a .clap bundle.
pub fn load_plugin_id_from_path(
    path: &Path,
    id: &str,
) -> Result<Option<FoundPlugin>, DiscoveryError> {
    let bundle_path =
        CString::new(path.to_string_lossy().as_bytes()).map_err(|_| DiscoveryError::NullBundlePath)?;

    // SAFETY: loading a native library is inherently unsafe.
    let library = unsafe { LibraryEntry::load_from_path(path) }?;
    let entry = unsafe { PluginEntry::load_from(library, &bundle_path) }?;

    let factory = entry
        .get_plugin_factory()
        .ok_or(DiscoveryError::MissingPluginFactory)?;

    Ok(factory
        .plugin_descriptors()
        .filter_map(|p| PluginDescriptor::try_from(p))
        .find(|p| p.id == id)
        .map(|plugin| FoundPlugin {
            entry,
            path: path.to_path_buf(),
            plugin,
        }))
}
