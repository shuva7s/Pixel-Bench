//! AVIF encoding for 8-bit RGBA pixels.
//!
//! Kept in its own crate so the rav1e build options (threads, assembly) are
//! chosen in one place.

use rgb::FromSlice;

/// Encodes `rgba` (`width * height * 4` bytes, straight alpha) as AVIF.
///
/// `quality` is 1..=100; `speed` is 1 (slowest, smallest) ..= 10 (fastest).
/// Fully opaque images are written without an alpha plane.
pub fn encode(
    rgba: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    speed: u8,
) -> Result<Vec<u8>, String> {
    if !(1..=100).contains(&quality) {
        return Err(format!(
            "AVIF quality must be between 1 and 100, got {quality}"
        ));
    }
    if !(1..=10).contains(&speed) {
        return Err(format!("AVIF speed must be between 1 and 10, got {speed}"));
    }
    if width == 0 || height == 0 || width > 65_535 || height > 65_535 {
        return Err(format!(
            "AVIF images must be 1 to 65535 px per side, got {width}x{height}"
        ));
    }
    let expected = width as usize * height as usize * 4;
    if rgba.len() != expected {
        return Err(format!(
            "expected {expected} bytes of RGBA, got {}",
            rgba.len()
        ));
    }
    let encoded = ravif::Encoder::new()
        .with_quality(f32::from(quality))
        .with_alpha_quality(f32::from(quality))
        .with_speed(speed)
        .encode_rgba(ravif::Img::new(
            rgba.as_rgba(),
            width as usize,
            height as usize,
        ))
        .map_err(|e| format!("AVIF encoding failed: {e}"))?;
    Ok(encoded.avif_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noisy(w: u32, h: u32, alpha: u8) -> Vec<u8> {
        let mut seed = 5u32;
        (0..w * h)
            .flat_map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let v = (seed >> 24) as u8;
                [v, v / 2, 255 - v, alpha]
            })
            .collect()
    }

    #[test]
    fn writes_an_avif_container() {
        let out = encode(&noisy(37, 23, 255), 37, 23, 70, 10).unwrap();
        assert_eq!(&out[4..12], b"ftypavif");
    }

    #[test]
    fn quality_controls_size() {
        let px = noisy(64, 64, 255);
        let low = encode(&px, 64, 64, 20, 10).unwrap().len();
        let high = encode(&px, 64, 64, 90, 10).unwrap().len();
        assert!(low < high, "q20={low} q90={high}");
    }

    #[test]
    fn transparency_adds_an_alpha_plane() {
        let opaque = encode(&noisy(32, 32, 255), 32, 32, 70, 10).unwrap();
        let translucent = encode(&noisy(32, 32, 128), 32, 32, 70, 10).unwrap();
        // The alpha plane is stored as an auxiliary image item.
        let has_aux = |b: &[u8]| b.windows(4).any(|w| w == b"auxC");
        assert!(!has_aux(&opaque));
        assert!(has_aux(&translucent));
    }

    #[test]
    fn rejects_invalid_input() {
        assert!(encode(&[0; 16], 2, 2, 0, 5).is_err());
        assert!(encode(&[0; 16], 2, 2, 50, 11).is_err());
        assert!(encode(&[0; 15], 2, 2, 50, 5).is_err());
        assert!(encode(&[], 0, 2, 50, 5).is_err());
    }
}
