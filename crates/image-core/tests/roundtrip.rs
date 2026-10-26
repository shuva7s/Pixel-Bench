//! End-to-end tests: real encoded files in, real encoded files out.

use image::{Rgba, RgbaImage};
use image_core::*;

fn opts(format: Format) -> EncodeOptions {
    match format {
        Format::Jpeg => EncodeOptions::Jpeg {
            quality: 90,
            progressive: false,
            background: [255, 255, 255],
        },
        Format::Png => EncodeOptions::Png {
            compression: PngCompression::Default,
        },
        Format::Webp => EncodeOptions::Webp,
        Format::Bmp => EncodeOptions::Bmp {
            background: [255, 255, 255],
        },
        Format::Gif => EncodeOptions::Gif,
        Format::Tiff => EncodeOptions::Tiff,
        Format::Ico => EncodeOptions::Ico,
        Format::Avif => unreachable!("AVIF is encoded by the avif-encoder crate"),
    }
}

/// Formats the engine decodes itself and that keep the image size.
const SIZE_KEEPING: [Format; 6] = [
    Format::Jpeg,
    Format::Png,
    Format::Webp,
    Format::Bmp,
    Format::Gif,
    Format::Tiff,
];

/// Colourful gradient with a fully transparent left column and a
/// half-transparent top row.
fn sample(w: u32, h: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        let a = if x == 0 {
            0
        } else if y == 0 {
            128
        } else {
            255
        };
        Rgba([(x * 255 / w) as u8, (y * 255 / h) as u8, 90, a])
    })
}

fn opaque_sample(w: u32, h: u32) -> RgbaImage {
    let mut img = sample(w, h);
    encode::flatten(&mut img, [0, 0, 0]);
    img
}

fn encoded(format: Format, img: &RgbaImage) -> Vec<u8> {
    encode(img.clone(), &opts(format)).unwrap()
}

#[test]
fn every_format_converts_to_every_format() {
    let src = sample(37, 23);
    for from in SIZE_KEEPING {
        let input = encoded(from, &src);
        assert_eq!(Format::detect(&input).unwrap(), from);
        for to in SIZE_KEEPING {
            let out = process(&input, &[], &opts(to), &DEFAULT_LIMITS)
                .unwrap_or_else(|e| panic!("{from:?} -> {to:?}: {e}"));
            assert_eq!(out.format, to);
            assert_eq!((out.width, out.height), (37, 23));
            assert_eq!(
                Format::detect(&out.bytes).unwrap(),
                to,
                "{from:?} -> {to:?}"
            );
            let back = decode(&out.bytes, &DEFAULT_LIMITS).unwrap();
            assert_eq!(back.image.dimensions(), (37, 23));
        }
    }
}

#[test]
fn icons_are_written_from_every_input() {
    let src = sample(37, 23);
    for from in SIZE_KEEPING {
        let input = encoded(from, &src);
        // ICO: square, largest standard size not above the image (32 px here).
        let ico = process(&input, &[], &opts(Format::Ico), &DEFAULT_LIMITS).unwrap();
        assert_eq!(Format::detect(&ico.bytes).unwrap(), Format::Ico, "{from:?}");
        assert_eq!(
            decode(&ico.bytes, &DEFAULT_LIMITS)
                .unwrap()
                .image
                .dimensions(),
            (32, 32)
        );
    }
}

#[test]
fn gif_keeps_one_bit_transparency() {
    let back = decode(&encoded(Format::Gif, &sample(20, 20)), &DEFAULT_LIMITS)
        .unwrap()
        .image;
    assert_eq!(
        back.get_pixel(0, 5)[3],
        0,
        "fully transparent stays transparent"
    );
    assert_eq!(back.get_pixel(5, 5)[3], 255, "opaque stays opaque");
}

#[test]
fn animated_gif_and_multi_page_tiff_are_rejected() {
    use image::codecs::gif::GifEncoder;
    use image::{Delay, Frame};
    let mut gif = Vec::new();
    {
        let mut enc = GifEncoder::new(&mut gif);
        let frames = [Rgba([255, 0, 0, 255]), Rgba([0, 0, 255, 255])].map(|c| {
            Frame::from_parts(
                RgbaImage::from_pixel(4, 4, c),
                0,
                0,
                Delay::from_numer_denom_ms(100, 1),
            )
        });
        enc.encode_frames(frames).unwrap();
    }
    assert_eq!(
        decode(&gif, &DEFAULT_LIMITS).unwrap_err().code(),
        ErrorCode::AnimatedNotSupported
    );
    assert!(inspect(&gif, &DEFAULT_LIMITS).unwrap().animated);

    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut enc = tiff::encoder::TiffEncoder::new(&mut cursor).unwrap();
        for _ in 0..2 {
            enc.write_image::<tiff::encoder::colortype::RGB8>(2, 2, &[0u8; 12])
                .unwrap();
        }
    }
    let tiff = cursor.into_inner();
    assert_eq!(
        decode(&tiff, &DEFAULT_LIMITS).unwrap_err().code(),
        ErrorCode::MultiPageNotSupported
    );
}

#[test]
fn lossless_formats_round_trip_exactly() {
    let src = sample(20, 20);
    for f in [Format::Png, Format::Webp, Format::Tiff] {
        let back = decode(&encoded(f, &src), &DEFAULT_LIMITS).unwrap();
        assert_eq!(back.image, src, "{f:?} must preserve pixels and alpha");
    }
    let opaque = opaque_sample(20, 20);
    let back = decode(&encoded(Format::Bmp, &opaque), &DEFAULT_LIMITS).unwrap();
    assert_eq!(back.image, opaque, "BMP must be lossless for opaque images");
}

#[test]
fn jpeg_and_bmp_flatten_transparency_onto_background() {
    let src = RgbaImage::from_pixel(16, 16, Rgba([0, 0, 0, 0]));
    for (format, opts) in [
        (
            Format::Jpeg,
            EncodeOptions::Jpeg {
                quality: 95,
                progressive: false,
                background: [255, 0, 0],
            },
        ),
        (
            Format::Bmp,
            EncodeOptions::Bmp {
                background: [255, 0, 0],
            },
        ),
    ] {
        let out = encode(src.clone(), &opts).unwrap();
        let back = decode(&out, &DEFAULT_LIMITS).unwrap().image;
        let p = back.get_pixel(8, 8);
        assert!(
            p[0] > 245 && p[1] < 10 && p[2] < 10 && p[3] == 255,
            "{format:?}: {p:?}"
        );
    }
}

#[test]
fn png_reduces_channels_losslessly() {
    let gray = RgbaImage::from_fn(64, 64, |x, y| {
        let v = ((x + y) * 2) as u8;
        Rgba([v, v, v, 255])
    });
    let png = encoded(Format::Png, &gray);
    let info = inspect(&png, &DEFAULT_LIMITS).unwrap();
    assert_eq!(info.color_model, "grayscale");
    assert_eq!(decode(&png, &DEFAULT_LIMITS).unwrap().image, gray);

    let info = inspect(&encoded(Format::Png, &opaque_sample(8, 8)), &DEFAULT_LIMITS).unwrap();
    assert_eq!(info.color_model, "rgb");
    let info = inspect(&encoded(Format::Png, &sample(8, 8)), &DEFAULT_LIMITS).unwrap();
    assert_eq!(info.color_model, "rgba");
    assert!(info.has_alpha_channel);
}

#[test]
fn jpeg_quality_controls_size() {
    // Noisy content so the quality setting matters.
    let mut seed = 1u32;
    let noisy = RgbaImage::from_fn(128, 128, |_, _| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let v = (seed >> 24) as u8;
        Rgba([v, v.wrapping_mul(3), v.wrapping_add(40), 255])
    });
    let size = |q| {
        encode(
            noisy.clone(),
            &EncodeOptions::Jpeg {
                quality: q,
                progressive: false,
                background: [0, 0, 0],
            },
        )
        .unwrap()
        .len()
    };
    let (low, high) = (size(20), size(95));
    assert!(low < high, "q20={low} q95={high}");

    let progressive = encode(
        noisy.clone(),
        &EncodeOptions::Jpeg {
            quality: 80,
            progressive: true,
            background: [0, 0, 0],
        },
    )
    .unwrap();
    assert_eq!(
        decode(&progressive, &DEFAULT_LIMITS)
            .unwrap()
            .image
            .dimensions(),
        (128, 128)
    );
}

#[test]
fn png_compression_levels_are_lossless() {
    let src = sample(50, 40);
    for c in [
        PngCompression::Fast,
        PngCompression::Default,
        PngCompression::Best,
    ] {
        let out = encode(src.clone(), &EncodeOptions::Png { compression: c }).unwrap();
        assert_eq!(decode(&out, &DEFAULT_LIMITS).unwrap().image, src, "{c:?}");
    }
}

#[test]
fn pipeline_applies_ops_in_order() {
    let input = encoded(Format::Png, &sample(40, 20));
    let ops: Vec<Operation> = serde_json::from_str(
        r#"[
            {"op":"crop","x":10,"y":0,"width":20,"height":10},
            {"op":"rotate","degrees":90},
            {"op":"resize","size":{"mode":"percent","percent":50},"filter":"lanczos3"},
            {"op":"flip","direction":"horizontal"},
            {"op":"develop","monochrome":true}
        ]"#,
    )
    .unwrap();
    let out = process(&input, &ops, &opts(Format::Png), &DEFAULT_LIMITS).unwrap();
    assert_eq!((out.width, out.height), (5, 10));
    let img = decode(&out.bytes, &DEFAULT_LIMITS).unwrap().image;
    assert!(img.pixels().all(|p| p[0] == p[1] && p[1] == p[2]));
}

#[test]
fn render_does_not_mutate_source() {
    let src = sample(10, 10);
    let ops = [Operation::Develop(Box::new(Develop {
        exposure: 1.0,
        ..Default::default()
    }))];
    let out = render(&src, &ops, &opts(Format::Png), &DEFAULT_LIMITS).unwrap();
    assert_eq!(src, sample(10, 10));
    assert_ne!(decode(&out.bytes, &DEFAULT_LIMITS).unwrap().image, src);
}

#[test]
fn invalid_ops_report_errors_before_encoding() {
    let input = encoded(Format::Png, &sample(10, 10));
    let crop = [Operation::Crop(CropRect {
        x: 5,
        y: 5,
        width: 10,
        height: 1,
    })];
    let err = process(&input, &crop, &opts(Format::Png), &DEFAULT_LIMITS).unwrap_err();
    assert_eq!(err.code(), ErrorCode::InvalidCrop);

    let bad_ops: std::result::Result<Vec<Operation>, _> =
        serde_json::from_str(r#"[{"op":"explode"}]"#);
    assert!(bad_ops.is_err());
}

#[test]
fn malformed_input_is_rejected_without_panicking() {
    let good = encoded(Format::Png, &sample(30, 30));
    let jpeg = encoded(Format::Jpeg, &sample(30, 30));
    let webp = encoded(Format::Webp, &sample(30, 30));
    let bmp = encoded(Format::Bmp, &sample(30, 30));
    let cases: Vec<Vec<u8>> = vec![
        vec![],
        b"not an image at all".to_vec(),
        b"GIF89a\x01\x00\x01\x00".to_vec(),
        good[..good.len() / 2].to_vec(),
        good[..20].to_vec(),
        jpeg[..jpeg.len() / 3].to_vec(),
        webp[..webp.len() / 2].to_vec(),
        bmp[..40].to_vec(),
        {
            let mut v = good.clone();
            for b in v.iter_mut().skip(40).step_by(7) {
                *b ^= 0x5a;
            }
            v
        },
    ];
    for (i, bytes) in cases.iter().enumerate() {
        let r = decode(bytes, &DEFAULT_LIMITS);
        assert!(r.is_err(), "case {i} should fail");
        let _ = inspect(bytes, &DEFAULT_LIMITS);
    }
    assert_eq!(
        decode(&[], &DEFAULT_LIMITS).unwrap_err().code(),
        ErrorCode::EmptyInput
    );
    assert_eq!(
        // Photoshop PSD: a real image format the engine does not support.
        decode(b"8BPS\x00\x01\x00\x00\x00\x00", &DEFAULT_LIMITS)
            .unwrap_err()
            .code(),
        ErrorCode::UnsupportedFormat
    );
    // A truncated GIF is a recognised format that fails to decode.
    assert_eq!(
        decode(b"GIF89a\x01\x00\x01\x00", &DEFAULT_LIMITS)
            .unwrap_err()
            .code(),
        ErrorCode::DecodeFailed
    );
}

#[test]
fn oversized_images_are_rejected_from_the_header() {
    let small = Limits {
        max_input_bytes: 10 * 1024 * 1024,
        max_side: 100,
        max_pixels: 5_000,
    };
    let png = encoded(Format::Png, &sample(80, 80)); // 6400 px > 5000
    let err = decode(&png, &small).unwrap_err();
    assert_eq!(err.code(), ErrorCode::TooLarge);
    // Inspection still works so the UI can explain the problem.
    let info = inspect(&png, &small).unwrap();
    assert_eq!((info.width, info.height), (80, 80));

    let wide = encoded(Format::Png, &RgbaImage::new(101, 1));
    assert_eq!(
        decode(&wide, &small).unwrap_err().code(),
        ErrorCode::TooLarge
    );
}

#[test]
fn forged_png_header_with_huge_dimensions_is_rejected_cheaply() {
    let mut png = encoded(Format::Png, &sample(4, 4));
    // IHDR width/height live at bytes 16..24; claim 60000x60000 (CRC now wrong,
    // which must also be handled gracefully).
    png[16..20].copy_from_slice(&60_000u32.to_be_bytes());
    png[20..24].copy_from_slice(&60_000u32.to_be_bytes());
    assert!(decode(&png, &DEFAULT_LIMITS).is_err());
}

#[test]
fn animated_png_is_rejected_explicitly() {
    let png = encoded(Format::Png, &sample(4, 4));
    // Insert an acTL chunk right after IHDR (8 sig + 25 IHDR bytes).
    let mut apng = png[..33].to_vec();
    apng.extend_from_slice(&8u32.to_be_bytes());
    apng.extend_from_slice(b"acTL");
    apng.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 0]);
    apng.extend_from_slice(&[0, 0, 0, 0]);
    apng.extend_from_slice(&png[33..]);
    assert!(inspect(&apng, &DEFAULT_LIMITS).unwrap().animated);
    assert_eq!(
        decode(&apng, &DEFAULT_LIMITS).unwrap_err().code(),
        ErrorCode::AnimatedNotSupported
    );
}

#[test]
fn jpeg_exif_orientation_is_applied() {
    // 4x2 image, left half red, right half blue.
    let img = RgbaImage::from_fn(4, 2, |x, _| {
        if x < 2 {
            Rgba([255, 0, 0, 255])
        } else {
            Rgba([0, 0, 255, 255])
        }
    });
    // Minimal big-endian EXIF with Orientation = 6 (rotate 90° clockwise).
    let mut exif = b"Exif\0\0MM\0\x2a\0\0\0\x08".to_vec();
    exif.extend_from_slice(&[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
    let mut jpeg = Vec::new();
    let mut enc = jpeg_encoder::Encoder::new(&mut jpeg, 100);
    enc.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_4_4);
    enc.add_app_segment(1, exif).unwrap();
    enc.encode(img.as_raw(), 4, 2, jpeg_encoder::ColorType::Rgba)
        .unwrap();

    let info = inspect(&jpeg, &DEFAULT_LIMITS).unwrap();
    assert!(info.orientation_corrected);
    assert_eq!((info.width, info.height), (2, 4));
    let decoded = decode(&jpeg, &DEFAULT_LIMITS).unwrap().image;
    assert_eq!(decoded.dimensions(), (2, 4));
    // After a clockwise turn the red (left) half is on top.
    assert!(decoded.get_pixel(0, 0)[0] > 200);
    assert!(decoded.get_pixel(0, 3)[2] > 200);
}

#[test]
fn thumbnail_never_upscales() {
    let src = sample(400, 100);
    assert_eq!(
        thumbnail(&src, 200, &DEFAULT_LIMITS).unwrap().dimensions(),
        (200, 50)
    );
    assert_eq!(
        thumbnail(&src, 1000, &DEFAULT_LIMITS).unwrap().dimensions(),
        (400, 100)
    );
}

#[test]
fn flat_colour_jpeg_round_trips_accurately() {
    // Regression: uniform images used to produce degenerate Huffman tables.
    for c in [[200u8, 100, 50], [128, 128, 128], [0, 0, 255]] {
        let src = RgbaImage::from_pixel(64, 64, Rgba([c[0], c[1], c[2], 255]));
        let out = encode(src.clone(), &opts(Format::Jpeg)).unwrap();
        let dec = decode(&out, &DEFAULT_LIMITS).unwrap().image;
        assert!(
            max_abs_diff(&dec, &src) <= 3,
            "{c:?}: max error {}",
            max_abs_diff(&dec, &src)
        );
    }
}

fn max_abs_diff(a: &RgbaImage, b: &RgbaImage) -> u8 {
    a.as_raw()
        .iter()
        .zip(b.as_raw())
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

/// Documents an upstream zune-jpeg 0.5.15 bug: a legal JPEG whose AC Huffman
/// table has a single symbol decodes with wrong colours. Run with
/// `cargo test -- --ignored` to check whether an upgrade has fixed it.
#[test]
#[ignore = "upstream zune-jpeg bug; see docs/FEATURES.md"]
fn upstream_single_symbol_huffman_table_decodes_correctly() {
    let src = RgbaImage::from_pixel(64, 64, Rgba([200, 100, 50, 255]));
    let mut out = Vec::new();
    let mut enc = jpeg_encoder::Encoder::new(&mut out, 90);
    enc.set_optimized_huffman_tables(true);
    enc.encode(src.as_raw(), 64, 64, jpeg_encoder::ColorType::Rgba)
        .unwrap();
    let dec = decode(&out, &DEFAULT_LIMITS).unwrap().image;
    assert!(
        max_abs_diff(&dec, &src) <= 3,
        "max error {}",
        max_abs_diff(&dec, &src)
    );
}

#[test]
fn full_editor_pipeline_runs_end_to_end() {
    let input = encoded(Format::Jpeg, &opaque_sample(120, 80));
    let ops: Vec<Operation> = serde_json::from_str(
        r#"[
            {"op":"flip","direction":"horizontal"},
            {"op":"rotate","degrees":90},
            {"op":"straighten","degrees":4},
            {"op":"crop","x":10,"y":10,"width":50,"height":60},
            {"op":"develop","exposure":0.3,"contrast":20,"highlights":-40,"shadows":30,
             "temperature":15,"vibrance":20,"mixerHue":[10,0,0,0,0,0,0,0],
             "clarity":30,"sharpenAmount":60,"vignette":-30,"grain":10}
        ]"#,
    )
    .unwrap();
    let out = process(&input, &ops, &opts(Format::Jpeg), &DEFAULT_LIMITS).unwrap();
    assert_eq!((out.width, out.height), (50, 60));
    assert_eq!(
        decode(&out.bytes, &DEFAULT_LIMITS)
            .unwrap()
            .image
            .dimensions(),
        (50, 60)
    );
}
