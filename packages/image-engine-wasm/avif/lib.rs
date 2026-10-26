//! wasm-bindgen bindings for the AVIF encoder (loaded on demand).

use wasm_bindgen::prelude::*;

/// Encodes straight-alpha RGBA pixels as AVIF. Throws an `Error` named
/// `INVALID_OPTIONS` (bad arguments) or `ENCODE_FAILED`.
#[wasm_bindgen(js_name = encodeAvif)]
pub fn encode_avif(
    rgba: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    speed: u8,
) -> Result<Vec<u8>, JsValue> {
    avif_encoder::encode(rgba, width, height, quality, speed).map_err(|msg| {
        let e = js_sys::Error::new(&msg);
        let invalid = msg.contains("must be") || msg.contains("expected");
        e.set_name(if invalid {
            "INVALID_OPTIONS"
        } else {
            "ENCODE_FAILED"
        });
        e.into()
    })
}
