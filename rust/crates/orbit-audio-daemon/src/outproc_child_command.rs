use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, Stdio};

/// `--shm`/`--chain`/`--sample-rate` を渡して rack effect child を 1 つ起動する。
/// `start_outproc_effect` の初回 spawn と watchdog の respawn が共有する。
///
/// パスは `OsStr` のまま渡す（lossy 変換しない）。`stderr` は **継承**して child の eprintln（plugin
/// process 失敗の集計報告等）を daemon stderr に出す（carry-forward ①③: child の可観測性）。
#[cfg(feature = "outproc-effect")]
pub(crate) fn effect_child_command(
    child_exe: &Path,
    shm_path: &Path,
    chain_manifest: &Path,
    sample_rate: u32,
    host_bundle_id: Option<&OsStr>,
) -> Command {
    let mut cmd = Command::new(child_exe);
    cmd.arg("--shm")
        .arg(shm_path)
        .arg("--chain")
        .arg(chain_manifest)
        .arg("--sample-rate")
        .arg(sample_rate.to_string())
        .stderr(Stdio::inherit());
    if let Some(host_bundle_id) = host_bundle_id {
        cmd.arg(crate::HOST_BUNDLE_ID_ARG).arg(host_bundle_id);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "outproc-effect")]
    #[test]
    fn effect_child_command_includes_host_bundle_id_only_when_configured() {
        let args_of = |host_bundle_id: Option<&OsStr>| -> Vec<String> {
            effect_child_command(
                Path::new("/bin/child"),
                Path::new("/tmp/shm"),
                Path::new("/tmp/chain.json"),
                48_000,
                host_bundle_id,
            )
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
        };

        let legacy = args_of(None);
        assert!(!legacy.iter().any(|arg| arg == "--host-bundle-id"));

        let configured = args_of(Some(OsStr::new("com.microsoft.VSCode")));
        assert_eq!(
            configured
                .windows(2)
                .find(|pair| pair[0] == "--host-bundle-id"),
            Some(
                &[
                    "--host-bundle-id".to_owned(),
                    "com.microsoft.VSCode".to_owned()
                ][..]
            )
        );
    }
}
