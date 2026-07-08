#[test]
#[ignore = "requires non-sandboxed commercial VST3 measurement environment"]
fn commercial_vst3_oop_smoke_gated() {
    eprintln!(
        "Run a non-sandboxed sweep by setting ORBIT_EFFECT_FORMAT=vst3 and ORBIT_EFFECT_PLUGIN to \
         the target .vst3 bundle, then drive the daemon OOP effect harness."
    );
}
