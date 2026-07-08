use std::env;
use std::path::Path;
use std::process;

fn main() {
    let Some(path) = env::args().nth(1) else {
        eprintln!("usage: vst3_probe <plugin.vst3>");
        process::exit(2);
    };

    let result = orbit_vst3_host::probe_plugin(Path::new(&path));
    println!("{}", result.to_json_line());
    if !result.loaded || !result.processed {
        process::exit(1);
    }
}
