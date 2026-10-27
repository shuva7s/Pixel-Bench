fn main() {
    // The prebuilt ONNX Runtime uses `@available` checks, which call
    // `__isPlatformVersionAtLeast` from clang's runtime library. Rust links
    // with `-nodefaultlibs`, so ask clang to add that library back.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-fapple-link-rtlib");
    }
    tauri_build::build()
}
