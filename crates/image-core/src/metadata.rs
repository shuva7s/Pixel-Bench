//! Metadata inspection and lossless removal.
//!
//! Inspection reports EXIF fields (via `kamadak-exif`) and which other
//! metadata blocks a file carries. Removal rewrites the file's *container*
//! without touching the compressed image data, so pixels stay bit-for-bit
//! identical. Supported containers: JPEG, PNG and WebP. Other formats lose
//! their metadata when re-encoded by the engine.

use serde::Serialize;

use crate::error::{EngineError, Result};
use crate::format::Format;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaField {
    /// "Image", "Camera", "GPS", "Interop" or "Thumbnail".
    pub group: &'static str,
    pub tag: String,
    pub value: String,
    /// Location, serial numbers, owner names and similar identifying data.
    pub sensitive: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataReport {
    pub fields: Vec<MetaField>,
    pub has_exif: bool,
    pub has_gps: bool,
    pub has_xmp: bool,
    pub has_iptc: bool,
    pub has_icc: bool,
    pub has_comments: bool,
    /// Bytes after the end of the image (e.g. embedded secondary images).
    pub has_trailing_data: bool,
    /// EXIF orientation (1–8), when present.
    pub orientation: Option<u16>,
    /// Whether `strip` can remove metadata from this container losslessly.
    pub strippable: bool,
}

impl MetadataReport {
    /// True when nothing removable is left (orientation and ICC may remain
    /// if they were asked to be kept).
    pub fn is_clean(&self, kept_orientation: bool, kept_icc: bool) -> bool {
        let only_orientation = self
            .fields
            .iter()
            .all(|f| kept_orientation && f.tag == "Orientation");
        only_orientation
            && !self.has_gps
            && !self.has_xmp
            && !self.has_iptc
            && !self.has_comments
            && !self.has_trailing_data
            && (kept_icc || !self.has_icc)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StripOptions {
    /// Keep the EXIF orientation tag so photos still display upright.
    pub keep_orientation: bool,
    /// Keep the ICC colour profile so colours render as intended.
    pub keep_icc: bool,
}

// ---------------------------------------------------------------------------
// Container walkers (bounds-checked; malformed input yields errors).
// ---------------------------------------------------------------------------

fn malformed(what: &str) -> EngineError {
    EngineError::Decode(format!("malformed {what} structure"))
}

#[derive(Debug, Clone, Copy)]
struct Segment {
    marker: u8,
    start: usize,
    end: usize,
}

/// JPEG segments before the first SOS, plus the offsets of the scan data
/// and of the end of the image (just after EOI).
fn jpeg_layout(b: &[u8]) -> Result<(Vec<Segment>, usize, usize)> {
    if b.get(..2) != Some(&[0xFF, 0xD8]) {
        return Err(malformed("JPEG"));
    }
    let mut segments = Vec::new();
    let mut pos = 2;
    loop {
        // Skip fill bytes between markers.
        while b.get(pos) == Some(&0xFF) && b.get(pos + 1) == Some(&0xFF) {
            pos += 1;
        }
        if b.get(pos) != Some(&0xFF) {
            return Err(malformed("JPEG"));
        }
        let marker = *b.get(pos + 1).ok_or_else(|| malformed("JPEG"))?;
        let len = u16::from_be_bytes([
            *b.get(pos + 2).ok_or_else(|| malformed("JPEG"))?,
            *b.get(pos + 3).ok_or_else(|| malformed("JPEG"))?,
        ]) as usize;
        let end = pos + 2 + len;
        if len < 2 || end > b.len() {
            return Err(malformed("JPEG"));
        }
        if marker == 0xDA {
            let scan_start = pos;
            let image_end = jpeg_image_end(b, end)?;
            return Ok((segments, scan_start, image_end));
        }
        segments.push(Segment {
            marker,
            start: pos,
            end,
        });
        pos = end;
    }
}

/// Walks entropy-coded data and any further marker segments (progressive
/// JPEGs have several scans) until EOI; returns the offset just past it.
fn jpeg_image_end(b: &[u8], mut pos: usize) -> Result<usize> {
    while pos + 1 < b.len() {
        if b[pos] != 0xFF {
            pos += 1;
            continue;
        }
        match b[pos + 1] {
            // Stuffed byte, restart markers and fill bytes are part of the scan.
            0x00 | 0xD0..=0xD7 | 0xFF => pos += 1,
            0xD9 => return Ok(pos + 2),
            _ => {
                let len = u16::from_be_bytes([
                    *b.get(pos + 2).ok_or_else(|| malformed("JPEG"))?,
                    *b.get(pos + 3).ok_or_else(|| malformed("JPEG"))?,
                ]) as usize;
                if len < 2 {
                    return Err(malformed("JPEG"));
                }
                pos += 2 + len;
            }
        }
    }
    Err(malformed("JPEG (no end-of-image marker)"))
}

#[derive(Debug, Clone, Copy)]
struct Chunk {
    kind: [u8; 4],
    start: usize,
    data_start: usize,
    end: usize,
}

/// PNG chunks up to and including IEND.
fn png_chunks(b: &[u8]) -> Result<Vec<Chunk>> {
    if b.get(..8) != Some(b"\x89PNG\r\n\x1a\n") {
        return Err(malformed("PNG"));
    }
    let mut chunks = Vec::new();
    let mut pos = 8;
    while let Some(h) = b.get(pos..pos + 8) {
        let len = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as usize;
        let kind = [h[4], h[5], h[6], h[7]];
        let end = pos
            .checked_add(12 + len)
            .filter(|&e| e <= b.len())
            .ok_or_else(|| malformed("PNG"))?;
        chunks.push(Chunk {
            kind,
            start: pos,
            data_start: pos + 8,
            end,
        });
        pos = end;
        if &kind == b"IEND" {
            return Ok(chunks);
        }
    }
    Err(malformed("PNG (no IEND chunk)"))
}

/// WebP RIFF chunks; the end offset includes the padding byte.
fn webp_chunks(b: &[u8]) -> Result<(Vec<Chunk>, usize)> {
    if b.get(..4) != Some(b"RIFF") || b.get(8..12) != Some(b"WEBP") {
        return Err(malformed("WebP"));
    }
    let riff_end = (u32::from_le_bytes([b[4], b[5], b[6], b[7]]) as usize)
        .checked_add(8)
        .filter(|&e| e <= b.len())
        .ok_or_else(|| malformed("WebP"))?;
    let mut chunks = Vec::new();
    let mut pos = 12;
    while pos + 8 <= riff_end {
        let kind = [b[pos], b[pos + 1], b[pos + 2], b[pos + 3]];
        let len = u32::from_le_bytes([b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]]) as usize;
        let end = (pos + 8 + len + (len & 1)).min(riff_end);
        if pos + 8 + len > riff_end {
            return Err(malformed("WebP"));
        }
        chunks.push(Chunk {
            kind,
            start: pos,
            data_start: pos + 8,
            end,
        });
        pos = end;
    }
    Ok((chunks, riff_end))
}

const XMP_SIG: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const EXTENDED_XMP_SIG: &[u8] = b"http://ns.adobe.com/xmp/extension/\0";

fn starts(data: &[u8], sig: &[u8]) -> bool {
    data.len() >= sig.len() && &data[..sig.len()] == sig
}

/// Keyword of a PNG text chunk (tEXt/zTXt/iTXt): bytes up to the first NUL.
fn png_keyword(data: &[u8]) -> &[u8] {
    data.split(|&c| c == 0).next().unwrap_or(&[])
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

const SENSITIVE_TAGS: &[&str] = &[
    "BodySerialNumber",
    "LensSerialNumber",
    "CameraOwnerName",
    "Artist",
    "ImageUniqueID",
    "HostComputer",
    "SerialNumber",
];

fn exif_fields(raw_tiff: Vec<u8>) -> (Vec<MetaField>, Option<u16>) {
    let Ok(exif) = exif::Reader::new().read_raw(raw_tiff) else {
        return (Vec::new(), None);
    };
    let orientation = exif
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .map(|v| v as u16);
    let mut fields = Vec::new();
    for f in exif.fields() {
        // Opaque vendor blobs are not meaningful to show.
        if f.tag == exif::Tag::MakerNote
            || matches!(f.value, exif::Value::Undefined(ref v, _) if v.len() > 64)
        {
            continue;
        }
        let group = if f.ifd_num == exif::In::THUMBNAIL {
            "Thumbnail"
        } else {
            match f.tag.context() {
                exif::Context::Gps => "GPS",
                exif::Context::Exif => "Camera",
                exif::Context::Interop => "Interop",
                _ => "Image",
            }
        };
        let tag = f.tag.to_string();
        let mut value = f.display_value().with_unit(&exif).to_string();
        if value.len() > 200 {
            value.truncate(197);
            value.push_str("...");
        }
        let sensitive = group == "GPS" || SENSITIVE_TAGS.contains(&tag.as_str());
        fields.push(MetaField {
            group,
            tag,
            value,
            sensitive,
        });
    }
    (fields, orientation)
}

pub fn inspect_metadata(bytes: &[u8]) -> Result<MetadataReport> {
    let format = Format::detect(bytes)?;
    let mut r = MetadataReport::default();
    let mut raw_exif: Option<Vec<u8>> = None;
    match format {
        Format::Jpeg => {
            let (segments, _, image_end) = jpeg_layout(bytes)?;
            r.strippable = true;
            r.has_trailing_data = image_end < bytes.len();
            for s in segments {
                let data = &bytes[s.start + 4..s.end];
                match s.marker {
                    0xE1 if starts(data, b"Exif\0\0") => {
                        r.has_exif = true;
                        raw_exif.get_or_insert_with(|| data[6..].to_vec());
                    }
                    0xE1 if starts(data, XMP_SIG) || starts(data, EXTENDED_XMP_SIG) => {
                        r.has_xmp = true
                    }
                    0xE2 if starts(data, b"ICC_PROFILE\0") => r.has_icc = true,
                    0xED => r.has_iptc = true,
                    0xFE => r.has_comments = true,
                    _ => {}
                }
            }
        }
        Format::Png => {
            let chunks = png_chunks(bytes)?;
            r.strippable = true;
            r.has_trailing_data = chunks.last().is_some_and(|c| c.end < bytes.len());
            for c in chunks {
                let data = &bytes[c.data_start..c.end - 4];
                match &c.kind {
                    b"eXIf" => {
                        r.has_exif = true;
                        raw_exif.get_or_insert_with(|| data.to_vec());
                    }
                    b"iCCP" => r.has_icc = true,
                    b"tEXt" | b"zTXt" | b"iTXt" => match png_keyword(data) {
                        b"XML:com.adobe.xmp" => r.has_xmp = true,
                        k if k.starts_with(b"Raw profile type exif") => r.has_exif = true,
                        k if k.starts_with(b"Raw profile type iptc") => r.has_iptc = true,
                        _ => r.has_comments = true,
                    },
                    b"tIME" => r.has_comments = true,
                    _ => {}
                }
            }
        }
        Format::Webp => {
            let (chunks, riff_end) = webp_chunks(bytes)?;
            r.strippable = true;
            r.has_trailing_data = riff_end < bytes.len();
            for c in chunks {
                let data = &bytes[c.data_start..c.end.min(bytes.len())];
                match &c.kind {
                    b"EXIF" => {
                        r.has_exif = true;
                        let tiff = if starts(data, b"Exif\0\0") {
                            &data[6..]
                        } else {
                            data
                        };
                        raw_exif.get_or_insert_with(|| tiff.to_vec());
                    }
                    b"XMP " => r.has_xmp = true,
                    b"ICCP" => r.has_icc = true,
                    _ => {}
                }
            }
        }
        // TIFF stores EXIF in its own IFDs; let the EXIF reader parse it.
        Format::Tiff => {
            if let Ok(exif) =
                exif::Reader::new().read_from_container(&mut std::io::Cursor::new(bytes))
            {
                r.has_exif = exif.fields().len() > 0;
                raw_exif = Some(exif.buf().to_vec());
            }
        }
        _ => {}
    }
    if let Some(raw) = raw_exif {
        let (fields, orientation) = exif_fields(raw);
        r.has_gps = fields.iter().any(|f| f.group == "GPS");
        r.orientation = orientation;
        r.fields = fields;
    }
    Ok(r)
}

// ---------------------------------------------------------------------------
// Lossless removal
// ---------------------------------------------------------------------------

/// A big-endian TIFF/EXIF block containing only the Orientation tag.
fn orientation_only_tiff(orientation: u16) -> Vec<u8> {
    let mut t = b"MM\0\x2a\0\0\0\x08".to_vec();
    t.extend_from_slice(&1u16.to_be_bytes()); // one IFD entry
    t.extend_from_slice(&0x0112u16.to_be_bytes()); // Orientation
    t.extend_from_slice(&3u16.to_be_bytes()); // SHORT
    t.extend_from_slice(&1u32.to_be_bytes()); // count
    t.extend_from_slice(&orientation.to_be_bytes());
    t.extend_from_slice(&[0, 0]); // value padding
    t.extend_from_slice(&0u32.to_be_bytes()); // no next IFD
    t
}

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut c = (data.len() as u32).to_be_bytes().to_vec();
    c.extend_from_slice(kind);
    c.extend_from_slice(data);
    let mut h = crc32fast::Hasher::new();
    h.update(kind);
    h.update(data);
    c.extend_from_slice(&h.finalize().to_be_bytes());
    c
}

/// Removes metadata without re-encoding. Returns the new file.
pub fn strip_metadata(bytes: &[u8], opts: StripOptions) -> Result<Vec<u8>> {
    let format = Format::detect(bytes)?;
    let before = inspect_metadata(bytes)?;
    let orientation = if opts.keep_orientation {
        before.orientation.filter(|&o| o != 1)
    } else {
        None
    };
    let out = match format {
        Format::Jpeg => {
            let (segments, scan_start, image_end) = jpeg_layout(bytes)?;
            let mut out = vec![0xFF, 0xD8];
            let mut wrote_orientation = false;
            for s in segments {
                let data = &bytes[s.start + 4..s.end];
                let keep = match s.marker {
                    // JFIF and Adobe (colour transform) affect decoding.
                    0xE0 | 0xEE => true,
                    0xE2 => opts.keep_icc && starts(data, b"ICC_PROFILE\0"),
                    0xE1 | 0xE3..=0xED | 0xEF | 0xFE => false,
                    _ => true,
                };
                // Put the minimal EXIF block right after JFIF/SOI.
                if !wrote_orientation && s.marker != 0xE0 {
                    if let Some(o) = orientation {
                        let mut payload = b"Exif\0\0".to_vec();
                        payload.extend(orientation_only_tiff(o));
                        out.extend_from_slice(&[0xFF, 0xE1]);
                        out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
                        out.extend(payload);
                    }
                    wrote_orientation = true;
                }
                if keep {
                    out.extend_from_slice(&bytes[s.start..s.end]);
                }
            }
            out.extend_from_slice(&bytes[scan_start..image_end]);
            out
        }
        Format::Png => {
            let chunks = png_chunks(bytes)?;
            let mut out = bytes[..8].to_vec();
            for c in chunks {
                let keep = match &c.kind {
                    b"eXIf" | b"tEXt" | b"zTXt" | b"iTXt" | b"tIME" => false,
                    b"iCCP" => opts.keep_icc,
                    _ => true,
                };
                if keep {
                    out.extend_from_slice(&bytes[c.start..c.end]);
                }
                if &c.kind == b"IHDR" {
                    if let Some(o) = orientation {
                        out.extend(png_chunk(b"eXIf", &orientation_only_tiff(o)));
                    }
                }
            }
            out
        }
        Format::Webp => {
            let (chunks, _) = webp_chunks(bytes)?;
            let mut body = Vec::new();
            for c in &chunks {
                let mut chunk = bytes[c.start..c.end].to_vec();
                match &c.kind {
                    b"EXIF" | b"XMP " => continue,
                    b"ICCP" if !opts.keep_icc => continue,
                    b"VP8X" if chunk.len() >= 9 => {
                        // Flags: ICC 0x20, EXIF 0x08, XMP 0x04.
                        let mut flags = chunk[8] & !0x04 & !0x08;
                        if !opts.keep_icc {
                            flags &= !0x20;
                        }
                        if orientation.is_some() {
                            flags |= 0x08;
                        }
                        chunk[8] = flags;
                    }
                    _ => {}
                }
                body.extend(chunk);
            }
            if let Some(o) = orientation {
                let tiff = orientation_only_tiff(o);
                body.extend_from_slice(b"EXIF");
                body.extend_from_slice(&(tiff.len() as u32).to_le_bytes());
                body.extend(tiff);
            }
            let mut out = b"RIFF".to_vec();
            out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
            out.extend_from_slice(b"WEBP");
            out.extend(body);
            out
        }
        _ => {
            return Err(EngineError::InvalidOptions(
                "lossless metadata removal supports JPEG, PNG and WebP; convert other formats instead".into(),
            ));
        }
    };
    // Verify: the result must be clean, or we report failure instead of
    // claiming success.
    let after = inspect_metadata(&out)?;
    if !after.is_clean(opts.keep_orientation, opts.keep_icc) {
        return Err(EngineError::Encode(
            "metadata could not be fully removed from this file".into(),
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DEFAULT_LIMITS, EncodeOptions, PngCompression, decode, encode};
    use image::{Rgba, RgbaImage};

    fn img() -> RgbaImage {
        RgbaImage::from_fn(16, 12, |x, y| {
            Rgba([(x * 15) as u8, (y * 20) as u8, 100, 255])
        })
    }

    /// Big-endian EXIF with Make, Orientation=6 and a GPS latitude.
    fn sample_exif() -> Vec<u8> {
        // IFD0: Make (ASCII), Orientation (SHORT), GPSInfo pointer (LONG).
        let mut t = b"MM\0\x2a\0\0\0\x08".to_vec();
        let ifd0_entries = 3u16;
        let ifd0_size = 2 + 12 * ifd0_entries as u32 + 4;
        let make_off = 8 + ifd0_size;
        let make = b"TestCam\0";
        let gps_off = make_off + make.len() as u32;
        t.extend_from_slice(&ifd0_entries.to_be_bytes());
        // Make
        t.extend_from_slice(&0x010Fu16.to_be_bytes());
        t.extend_from_slice(&2u16.to_be_bytes());
        t.extend_from_slice(&(make.len() as u32).to_be_bytes());
        t.extend_from_slice(&make_off.to_be_bytes());
        // Orientation = 6
        t.extend_from_slice(&0x0112u16.to_be_bytes());
        t.extend_from_slice(&3u16.to_be_bytes());
        t.extend_from_slice(&1u32.to_be_bytes());
        t.extend_from_slice(&[0, 6, 0, 0]);
        // GPS IFD pointer
        t.extend_from_slice(&0x8825u16.to_be_bytes());
        t.extend_from_slice(&4u16.to_be_bytes());
        t.extend_from_slice(&1u32.to_be_bytes());
        t.extend_from_slice(&gps_off.to_be_bytes());
        t.extend_from_slice(&0u32.to_be_bytes());
        t.extend_from_slice(make);
        // GPS IFD: GPSLatitudeRef = "N"
        t.extend_from_slice(&1u16.to_be_bytes());
        t.extend_from_slice(&0x0001u16.to_be_bytes());
        t.extend_from_slice(&2u16.to_be_bytes());
        t.extend_from_slice(&2u32.to_be_bytes());
        t.extend_from_slice(b"N\0\0\0");
        t.extend_from_slice(&0u32.to_be_bytes());
        t
    }

    fn jpeg_with_metadata() -> Vec<u8> {
        let mut jpeg = Vec::new();
        let mut enc = jpeg_encoder::Encoder::new(&mut jpeg, 90);
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(sample_exif());
        enc.add_app_segment(1, app1).unwrap();
        let mut xmp = XMP_SIG.to_vec();
        xmp.extend_from_slice(b"<x:xmpmeta>secret</x:xmpmeta>");
        enc.add_app_segment(1, xmp).unwrap();
        enc.add_app_segment(13, b"Photoshop 3.0\0iptc".to_vec())
            .unwrap();
        enc.add_icc_profile(&[0u8; 200]).unwrap();
        enc.encode(img().as_raw(), 16, 12, jpeg_encoder::ColorType::Rgba)
            .unwrap();
        // A comment and trailing data (like an appended secondary image).
        let mut with_com = jpeg[..2].to_vec();
        with_com.extend_from_slice(&[0xFF, 0xFE, 0, 7, b'h', b'e', b'l', b'l', b'o']);
        with_com.extend_from_slice(&jpeg[2..]);
        with_com.extend_from_slice(b"TRAILING-SECRET");
        with_com
    }

    #[test]
    fn inspects_jpeg_metadata() {
        let r = inspect_metadata(&jpeg_with_metadata()).unwrap();
        assert!(r.has_exif && r.has_gps && r.has_xmp && r.has_iptc && r.has_icc && r.has_comments);
        assert!(r.has_trailing_data);
        assert_eq!(r.orientation, Some(6));
        let make = r.fields.iter().find(|f| f.tag == "Make").unwrap();
        assert!(make.value.contains("TestCam"));
        assert!(r.fields.iter().any(|f| f.group == "GPS" && f.sensitive));
    }

    #[test]
    fn strips_jpeg_losslessly_and_verifies() {
        let src = jpeg_with_metadata();
        let opts = StripOptions {
            keep_orientation: false,
            keep_icc: false,
        };
        let out = strip_metadata(&src, opts).unwrap();
        let r = inspect_metadata(&out).unwrap();
        assert!(r.is_clean(false, false), "{r:?}");
        assert!(!r.has_exif && !r.has_icc && !r.has_trailing_data);
        assert!(!out.windows(6).any(|w| w == b"secret"));
        assert!(!out.windows(15).any(|w| w == b"TRAILING-SECRET"));
        // Pixels are identical: the compressed image data was not touched.
        let a = decode(&src, &DEFAULT_LIMITS).unwrap().image;
        let b = decode(&out, &DEFAULT_LIMITS).unwrap().image;
        // Source orientation 6 rotates on decode; stripped file is upright.
        assert_eq!(a.dimensions(), (12, 16));
        assert_eq!(b.dimensions(), (16, 12));
    }

    #[test]
    fn keeps_orientation_and_icc_when_asked() {
        let src = jpeg_with_metadata();
        let out = strip_metadata(
            &src,
            StripOptions {
                keep_orientation: true,
                keep_icc: true,
            },
        )
        .unwrap();
        let r = inspect_metadata(&out).unwrap();
        assert_eq!(r.orientation, Some(6));
        assert!(r.has_icc && !r.has_gps && !r.has_xmp);
        assert_eq!(r.fields.len(), 1, "{:?}", r.fields);
        assert_eq!(
            decode(&src, &DEFAULT_LIMITS).unwrap().image,
            decode(&out, &DEFAULT_LIMITS).unwrap().image,
            "same pixels, same orientation"
        );
    }

    #[test]
    fn strips_png_text_and_exif_chunks() {
        let png = encode(
            img(),
            &EncodeOptions::Png {
                compression: PngCompression::Fast,
            },
        )
        .unwrap();
        let chunks = png_chunks(&png).unwrap();
        let ihdr_end = chunks[0].end;
        let mut with = png[..ihdr_end].to_vec();
        with.extend(png_chunk(b"eXIf", &sample_exif()));
        with.extend(png_chunk(b"tEXt", b"Author\0Someone"));
        with.extend(png_chunk(b"iTXt", b"XML:com.adobe.xmp\0\0\0\0\0<x/>"));
        with.extend_from_slice(&png[ihdr_end..]);
        let r = inspect_metadata(&with).unwrap();
        assert!(r.has_exif && r.has_comments && r.has_xmp && r.has_gps);
        let out = strip_metadata(
            &with,
            StripOptions {
                keep_orientation: false,
                keep_icc: false,
            },
        )
        .unwrap();
        assert!(inspect_metadata(&out).unwrap().is_clean(false, false));
        assert_eq!(decode(&out, &DEFAULT_LIMITS).unwrap().image, img());
    }

    #[test]
    fn strips_webp_chunks_and_fixes_flags() {
        let webp = encode(img(), &EncodeOptions::Webp).unwrap();
        // Wrap the simple VP8L file in an extended (VP8X) container with EXIF + XMP.
        let image_chunk = webp[12..].to_vec();
        let exif = sample_exif();
        let mut body = b"VP8X".to_vec();
        body.extend_from_slice(&10u32.to_le_bytes());
        body.extend_from_slice(&[0x08 | 0x04, 0, 0, 0]);
        body.extend_from_slice(&15u32.to_le_bytes()[..3]); // width-1
        body.extend_from_slice(&11u32.to_le_bytes()[..3]); // height-1
        body.extend(image_chunk);
        body.extend_from_slice(b"EXIF");
        body.extend_from_slice(&(exif.len() as u32).to_le_bytes());
        body.extend(&exif);
        if exif.len() % 2 == 1 {
            body.push(0);
        }
        body.extend_from_slice(b"XMP ");
        body.extend_from_slice(&4u32.to_le_bytes());
        body.extend_from_slice(b"<x/>");
        let mut file = b"RIFF".to_vec();
        file.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
        file.extend_from_slice(b"WEBP");
        file.extend(body);

        let r = inspect_metadata(&file).unwrap();
        assert!(r.has_exif && r.has_xmp && r.has_gps);
        let out = strip_metadata(
            &file,
            StripOptions {
                keep_orientation: false,
                keep_icc: false,
            },
        )
        .unwrap();
        let after = inspect_metadata(&out).unwrap();
        assert!(after.is_clean(false, false), "{after:?}");
        assert_eq!(out[20] & 0x0C, 0, "EXIF/XMP flags cleared");
        assert_eq!(decode(&out, &DEFAULT_LIMITS).unwrap().image, img());
    }

    #[test]
    fn engine_output_carries_no_metadata() {
        let out = crate::process(
            &jpeg_with_metadata(),
            &[],
            &EncodeOptions::Jpeg {
                quality: 80,
                progressive: false,
                background: [255; 3],
            },
            &DEFAULT_LIMITS,
        )
        .unwrap();
        let r = inspect_metadata(&out.bytes).unwrap();
        assert!(r.is_clean(false, false) && !r.has_exif, "{r:?}");
    }

    #[test]
    fn malformed_containers_error_without_panicking() {
        let src = jpeg_with_metadata();
        for cut in [3, 10, 40, src.len() / 2] {
            let _ = inspect_metadata(&src[..cut]);
            let _ = strip_metadata(
                &src[..cut],
                StripOptions {
                    keep_orientation: true,
                    keep_icc: true,
                },
            );
        }
        let png = encode(
            img(),
            &EncodeOptions::Png {
                compression: PngCompression::Fast,
            },
        )
        .unwrap();
        assert!(
            strip_metadata(
                &png[..30],
                StripOptions {
                    keep_orientation: false,
                    keep_icc: false
                }
            )
            .is_err()
        );
    }

    #[test]
    fn other_formats_explain_that_lossless_removal_is_unsupported() {
        let bmp = encode(img(), &EncodeOptions::Bmp { background: [0; 3] }).unwrap();
        assert!(!inspect_metadata(&bmp).unwrap().strippable);
        assert!(matches!(
            strip_metadata(
                &bmp,
                StripOptions {
                    keep_orientation: false,
                    keep_icc: false
                }
            ),
            Err(EngineError::InvalidOptions(_))
        ));
    }
}
