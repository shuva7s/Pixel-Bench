// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    wsl_rendering_workaround();
    pixel_bench_lib::run();
}

/// Under WSL (WSLg), WebKitGTK's accelerated compositing leaves the window
/// blank after it has been covered by another window, and its DMA-BUF
/// renderer can fail to start. Both are turned off there; ordinary Linux
/// desktops are unaffected. Users can still override either variable.
#[cfg(target_os = "linux")]
fn wsl_rendering_workaround() {
    let in_wsl = std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|r| r.to_lowercase().contains("microsoft"));
    if !in_wsl {
        return;
    }
    for key in [
        "WEBKIT_DISABLE_COMPOSITING_MODE",
        "WEBKIT_DISABLE_DMABUF_RENDERER",
    ] {
        if std::env::var_os(key).is_none() {
            // SAFETY: runs first thing in `main`, before any other thread exists.
            unsafe { std::env::set_var(key, "1") };
        }
    }
}
