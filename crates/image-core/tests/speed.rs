//! Timing of the heavy operations on a 24 MP photo-like image. Ignored by
//! default; run with `cargo test --release -p image-core --test speed -- --ignored --nocapture`
//! (add `--features parallel` for the multi-threaded build).

use std::time::Instant;

use image_core::{
    DEFAULT_LIMITS, Develop, EncodeOptions, Operation, ResizeFilter, ResizeMode, RgbaImage,
};

fn photo() -> RgbaImage {
    let mut seed = 1u32;
    RgbaImage::from_fn(6000, 4000, |x, y| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let n = (seed >> 28) as u8;
        image::Rgba([
            (x / 24) as u8 ^ n,
            (y / 16) as u8,
            ((x + y) / 40) as u8 ^ n,
            255,
        ])
    })
}

fn time(name: &str, img: &RgbaImage, ops: &[Operation]) {
    let mut best = f64::MAX;
    for _ in 0..3 {
        let t = Instant::now();
        let out = image_core::ops::apply_all(img.clone(), ops, &DEFAULT_LIMITS).unwrap();
        std::hint::black_box(out);
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
    }
    println!("{name:<34} {best:>7.0} ms");
}

#[test]
#[ignore]
fn speed() {
    let img = photo();
    let dev = |d: Develop| vec![Operation::Develop(Box::new(d))];
    let light = Develop {
        exposure: 0.3,
        contrast: 20.0,
        highlights: -30.0,
        shadows: 25.0,
        temperature: 10.0,
        saturation: 15.0,
        ..Default::default()
    };
    let mixer = Develop {
        mixer_hue: [10.0, 0.0, 0.0, -10.0, 0.0, 15.0, 0.0, 0.0],
        mixer_saturation: [0.0, 20.0, 0.0, 0.0, -20.0, 0.0, 0.0, 0.0],
        ..light
    };
    let local = Develop {
        clarity: 30.0,
        sharpen_amount: 60.0,
        sharpen_radius: 1.0,
        ..light
    };
    let fx = Develop {
        vignette: -30.0,
        vignette_midpoint: 50.0,
        grain: 20.0,
        ..light
    };
    time("develop: light + colour", &img, &dev(light));
    time("develop: + colour mixer", &img, &dev(mixer));
    time("develop: + clarity + sharpening", &img, &dev(local));
    time("develop: + vignette + grain", &img, &dev(fx));
    time(
        "blur 50",
        &img,
        &dev(Develop {
            blur: 50.0,
            ..Default::default()
        }),
    );
    time(
        "straighten 3°",
        &img,
        &[Operation::Straighten { degrees: 3.0 }],
    );
    time(
        "resize to 50% (Lanczos3)",
        &img,
        &[Operation::Resize {
            size: ResizeMode::Percent { percent: 50.0 },
            filter: ResizeFilter::Lanczos3,
        }],
    );
    let t = Instant::now();
    std::hint::black_box(
        image_core::encode(
            img.clone(),
            &EncodeOptions::Jpeg {
                quality: 85,
                progressive: false,
                background: [255; 3],
            },
        )
        .unwrap(),
    );
    println!(
        "{:<34} {:>7.0} ms",
        "encode JPEG q85",
        t.elapsed().as_secs_f64() * 1000.0
    );
}
