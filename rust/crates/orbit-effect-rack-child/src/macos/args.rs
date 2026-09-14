use std::path::PathBuf;

pub(super) struct Args {
    pub(super) shm: PathBuf,
    pub(super) chain: PathBuf,
    pub(super) sample_rate: u32,
}
