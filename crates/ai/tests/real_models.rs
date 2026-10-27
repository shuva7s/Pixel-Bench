//! Runs the real models on synthetic images with a known answer.
//! BiRefNet (110 MB, not in the repo) runs when `BIREFNET_DIR` points to a
//! folder holding `birefnet-lite-fp16.onnx`.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use ai::{Backend, Device, ModelDirs, ModelId, Runtime};
use image::{Rgba, RgbaImage};

fn dirs() -> ModelDirs {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../models");
    let downloads = std::env::var_os("BIREFNET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    ModelDirs {
        bundled: root,
        downloads,
    }
}

/// A red disc on a textured green/blue background.
fn disc(w: u32, h: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        let (fx, fy) = (
            (x as f32 - w as f32 / 2.0) / (w as f32 * 0.23),
            (y as f32 - h as f32 / 2.0) / (h as f32 * 0.33),
        );
        if fx * fx + fy * fy < 1.0 {
            Rgba([210, 40, 30, 255])
        } else {
            Rgba([
                (60.0 + 30.0 * (x as f32 / 9.0).sin()) as u8,
                (140.0 + 25.0 * (y as f32 / 7.0).cos()) as u8,
                120,
                255,
            ])
        }
    })
}

fn check_cutout(rt: &Runtime, id: ModelId) {
    let img = disc(400, 300);
    let seg = rt.segment(&img, id, Device::Cpu).unwrap();
    assert_eq!(seg.backend, Backend::Cpu);
    let at = |fx: f32, fy: f32| {
        seg.mask[(fy * seg.size as f32) as usize * seg.size + (fx * seg.size as f32) as usize]
    };
    assert!(
        at(0.5, 0.5) > 200,
        "{id:?}: subject kept ({})",
        at(0.5, 0.5)
    );
    assert!(
        at(0.03, 0.03) < 40,
        "{id:?}: background removed ({})",
        at(0.03, 0.03)
    );
    eprintln!("{id:?}: {} ms on the CPU", seg.millis);
}

#[test]
fn u2netp_finds_the_subject() {
    check_cutout(&Runtime::new(dirs()).unwrap(), ModelId::U2Netp);
}

#[test]
fn birefnet_finds_the_subject_on_the_cpu() {
    if !dirs().is_present(ModelId::BiRefNetLite) {
        eprintln!("skipped: set BIREFNET_DIR to run BiRefNet");
        return;
    }
    check_cutout(&Runtime::new(dirs()).unwrap(), ModelId::BiRefNetLite);
}

#[test]
fn realesrgan_upscales_2x_and_4x() {
    let rt = Runtime::new(dirs()).unwrap();
    // Smooth content: a correct model stays close to a plain Lanczos enlargement.
    let mut img = RgbaImage::from_fn(70, 50, |x, y| {
        let (fx, fy) = (x as f32, y as f32);
        Rgba([
            (fx * 3.0) as u8,
            (fy * 5.0) as u8,
            (128.0 + 100.0 * (fx / 6.0).sin() * (fy / 9.0).cos()) as u8,
            255,
        ])
    });
    img.put_pixel(0, 0, Rgba([0, 0, 0, 0]));
    let cancel = AtomicBool::new(false);
    for factor in [2, 4] {
        let mut last = 0.0;
        let (out, backend) = rt
            .upscale(&img, factor, Device::Cpu, |p| last = p, &cancel)
            .unwrap();
        assert_eq!((out.width(), out.height()), (70 * factor, 50 * factor));
        assert_eq!(backend, Backend::Cpu);
        assert_eq!(last, 1.0);
        let reference = image::imageops::resize(
            &img,
            70 * factor,
            50 * factor,
            image::imageops::FilterType::Lanczos3,
        );
        let diff: f64 = out
            .as_raw()
            .chunks_exact(4)
            .zip(reference.as_raw().chunks_exact(4))
            .map(|(a, b)| (0..3).map(|c| f64::from(a[c].abs_diff(b[c]))).sum::<f64>() / 3.0)
            .sum::<f64>()
            / f64::from(out.width() * out.height());
        eprintln!("{factor}x: mean difference to Lanczos {diff:.1} levels");
        assert!(
            diff < 12.0,
            "{factor}x output differs from a plain enlargement by {diff:.1} levels on average"
        );
        assert_eq!(out.get_pixel(0, 0).0[3], 0, "transparency is kept");
    }
    assert_eq!(
        rt.upscale(&RgbaImage::new(2000, 2000), 4, Device::Cpu, |_| {}, &cancel)
            .unwrap_err()
            .code,
        "TOO_LARGE"
    );
}
