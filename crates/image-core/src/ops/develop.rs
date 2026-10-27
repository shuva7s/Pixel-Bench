//! Lightroom-style global adjustments ("develop" settings).
//!
//! Pipeline, in order:
//! 1. sRGB → linear, white balance (temperature/tint) and exposure.
//! 2. Tone curve built from contrast/highlights/shadows/whites/blacks
//!    (monotone cubic through control points, in gamma space). Steps 1–2 are
//!    folded into one 256-entry table per channel.
//! 3. Colour: HSL mixer (8 bands), vibrance, saturation, black & white.
//! 4. Local operations on luminance: clarity, sharpening.
//! 5. Finishing: vignette, grain.

use image::RgbaImage;
use serde::Deserialize;

use crate::error::{EngineError, Result};
use crate::par::{for_bands, for_rows};

pub const BANDS: usize = 8;
/// Band centres in degrees: red, orange, yellow, green, aqua, blue, purple, magenta.
const BAND_CENTRES: [f32; BANDS] = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0];

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Develop {
    /// -100..=100 (cool … warm).
    pub temperature: f32,
    /// -100..=100 (green … magenta).
    pub tint: f32,
    /// -5..=5 stops.
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub vibrance: f32,
    pub saturation: f32,
    /// Per-band hue shift, -100..=100 (±30°).
    pub mixer_hue: [f32; BANDS],
    /// Per-band saturation, -100..=100.
    pub mixer_saturation: [f32; BANDS],
    /// Per-band luminance, -100..=100.
    pub mixer_luminance: [f32; BANDS],
    pub monochrome: bool,
    /// -100..=100 local contrast.
    pub clarity: f32,
    /// 0..=100 Gaussian blur (100 ≈ 2% of the long side).
    pub blur: f32,
    /// 0..=150.
    pub sharpen_amount: f32,
    /// 0.5..=3 px at full resolution.
    pub sharpen_radius: f32,
    /// -100..=100 (darken … lighten edges).
    pub vignette: f32,
    /// 0..=100, where the vignette starts.
    pub vignette_midpoint: f32,
    /// 0..=100.
    pub grain: f32,
}

impl Default for Develop {
    fn default() -> Self {
        Develop {
            temperature: 0.0,
            tint: 0.0,
            exposure: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            vibrance: 0.0,
            saturation: 0.0,
            mixer_hue: [0.0; BANDS],
            mixer_saturation: [0.0; BANDS],
            mixer_luminance: [0.0; BANDS],
            monochrome: false,
            clarity: 0.0,
            blur: 0.0,
            sharpen_amount: 0.0,
            sharpen_radius: 1.0,
            vignette: 0.0,
            vignette_midpoint: 50.0,
            grain: 0.0,
        }
    }
}

fn check(name: &str, v: f32, min: f32, max: f32) -> Result<()> {
    if v.is_finite() && (min..=max).contains(&v) {
        Ok(())
    } else {
        Err(EngineError::InvalidOptions(format!(
            "{name} must be between {min} and {max}, got {v}"
        )))
    }
}

impl Develop {
    pub fn validate(&self) -> Result<()> {
        for (name, v) in [
            ("temperature", self.temperature),
            ("tint", self.tint),
            ("contrast", self.contrast),
            ("highlights", self.highlights),
            ("shadows", self.shadows),
            ("whites", self.whites),
            ("blacks", self.blacks),
            ("vibrance", self.vibrance),
            ("saturation", self.saturation),
            ("clarity", self.clarity),
            ("vignette", self.vignette),
        ] {
            check(name, v, -100.0, 100.0)?;
        }
        for i in 0..BANDS {
            check("mixer hue", self.mixer_hue[i], -100.0, 100.0)?;
            check("mixer saturation", self.mixer_saturation[i], -100.0, 100.0)?;
            check("mixer luminance", self.mixer_luminance[i], -100.0, 100.0)?;
        }
        check("exposure", self.exposure, -5.0, 5.0)?;
        check("blur", self.blur, 0.0, 100.0)?;
        check("sharpening amount", self.sharpen_amount, 0.0, 150.0)?;
        check("sharpening radius", self.sharpen_radius, 0.5, 3.0)?;
        check("vignette midpoint", self.vignette_midpoint, 0.0, 100.0)?;
        check("grain", self.grain, 0.0, 100.0)
    }

    fn tone_is_identity(&self) -> bool {
        [
            self.temperature,
            self.tint,
            self.exposure,
            self.contrast,
            self.highlights,
            self.shadows,
            self.whites,
            self.blacks,
        ]
        .iter()
        .all(|v| *v == 0.0)
    }

    fn mixer_is_identity(&self) -> bool {
        self.mixer_hue
            .iter()
            .chain(&self.mixer_saturation)
            .chain(&self.mixer_luminance)
            .all(|v| *v == 0.0)
    }

    fn color_is_identity(&self) -> bool {
        self.vibrance == 0.0
            && self.saturation == 0.0
            && !self.monochrome
            && self.mixer_is_identity()
    }

    pub fn is_identity(&self) -> bool {
        self.tone_is_identity()
            && self.color_is_identity()
            && self.clarity == 0.0
            && self.blur == 0.0
            && self.sharpen_amount == 0.0
            && self.vignette == 0.0
            && self.grain == 0.0
    }

    /// Returns settings adjusted for rendering on a copy downscaled by
    /// `scale`, so pixel-radius effects look the same in previews.
    pub fn scaled(&self, scale: f64) -> Develop {
        Develop {
            sharpen_radius: ((self.sharpen_radius as f64 * scale) as f32).clamp(0.5, 3.0),
            ..*self
        }
    }
}

// ---------------------------------------------------------------------------
// Stage 1–2: white balance, exposure and tone curve as lookup tables.
// ---------------------------------------------------------------------------

/// Linear values above this are clipped; corresponds to gamma value ~2.
const MAX_LIN: f32 = 5.0;

fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// Monotone cubic (Fritsch–Carlson) interpolation through `(xs, ys)`.
struct MonotoneCurve {
    xs: Vec<f32>,
    ys: Vec<f32>,
    ms: Vec<f32>,
}

impl MonotoneCurve {
    fn new(xs: &[f32], ys: &[f32]) -> Self {
        let n = xs.len();
        let d: Vec<f32> = (0..n - 1)
            .map(|i| (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
            .collect();
        let mut ms = vec![0.0; n];
        ms[0] = d[0];
        ms[n - 1] = d[n - 2];
        for i in 1..n - 1 {
            ms[i] = if d[i - 1] * d[i] <= 0.0 {
                0.0
            } else {
                (d[i - 1] + d[i]) / 2.0
            };
        }
        for i in 0..n - 1 {
            if d[i] == 0.0 {
                ms[i] = 0.0;
                ms[i + 1] = 0.0;
                continue;
            }
            let a = ms[i] / d[i];
            let b = ms[i + 1] / d[i];
            let s = a * a + b * b;
            if s > 9.0 {
                let t = 3.0 / s.sqrt();
                ms[i] = t * a * d[i];
                ms[i + 1] = t * b * d[i];
            }
        }
        MonotoneCurve {
            xs: xs.to_vec(),
            ys: ys.to_vec(),
            ms,
        }
    }

    fn eval(&self, x: f32) -> f32 {
        let n = self.xs.len();
        if x <= self.xs[0] {
            return self.ys[0] + self.ms[0] * (x - self.xs[0]);
        }
        if x >= self.xs[n - 1] {
            return self.ys[n - 1] + self.ms[n - 1] * (x - self.xs[n - 1]);
        }
        let i = (0..n - 1).find(|&i| x < self.xs[i + 1]).unwrap_or(n - 2);
        let h = self.xs[i + 1] - self.xs[i];
        let t = (x - self.xs[i]) / h;
        let (t2, t3) = (t * t, t * t * t);
        (2.0 * t3 - 3.0 * t2 + 1.0) * self.ys[i]
            + (t3 - 2.0 * t2 + t) * h * self.ms[i]
            + (-2.0 * t3 + 3.0 * t2) * self.ys[i + 1]
            + (t3 - t2) * h * self.ms[i + 1]
    }
}

fn tone_curve(d: &Develop) -> MonotoneCurve {
    let (c, h, s) = (d.contrast / 100.0, d.highlights / 100.0, d.shadows / 100.0);
    let (w, b) = (d.whites / 100.0, d.blacks / 100.0);
    let xs = [0.0, 0.25, 0.5, 0.75, 1.0, 2.0];
    let y4 = 1.0 + 0.10 * w + 0.10 * h.min(0.0);
    let mut ys = [
        0.10 * b,
        0.25 + 0.12 * s - 0.06 * c,
        0.5,
        0.75 + 0.12 * h + 0.06 * c,
        y4,
        // Above white: values only reach here through exposure. Negative
        // highlights compress them back into range ("recovery").
        y4 + (0.6 * (1.0 + h)).max(0.05),
    ];
    for i in 1..ys.len() {
        ys[i] = ys[i].max(ys[i - 1] + 1e-3);
    }
    MonotoneCurve::new(&xs, &ys)
}

/// Stages 1–2 depend only on each 8-bit channel value, so they collapse into
/// one 256-entry table per channel (output: gamma value in [0, 1]).
struct ToneTables {
    lut: [[f32; 256]; 3],
}

fn tone_tables(d: &Develop) -> ToneTables {
    let (t, m) = (d.temperature / 100.0, d.tint / 100.0);
    let mut gains = [
        (1.0 + 0.3 * t) * (1.0 + 0.1 * m),
        1.0 - 0.2 * m,
        (1.0 - 0.3 * t) * (1.0 + 0.1 * m),
    ];
    // Keep overall luminance stable while shifting the balance.
    let lum = 0.2126 * gains[0] + 0.7152 * gains[1] + 0.0722 * gains[2];
    let ev = 2f32.powf(d.exposure);
    for g in &mut gains {
        *g *= ev / lum;
    }
    let curve = tone_curve(d);
    let lut = std::array::from_fn(|c| {
        std::array::from_fn(|v| {
            let lin = (srgb_to_linear(v as f32 / 255.0) * gains[c]).clamp(0.0, MAX_LIN);
            curve.eval(linear_to_srgb(lin).min(2.0)).clamp(0.0, 1.0)
        })
    });
    ToneTables { lut }
}

impl ToneTables {
    #[inline]
    fn apply(&self, c: usize, v: u8) -> f32 {
        self.lut[c][v as usize]
    }
}

// ---------------------------------------------------------------------------
// Stage 3: colour.
// ---------------------------------------------------------------------------

#[inline]
fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// `deg mod 360` without `rem_euclid`, which compiles to a slow libm call
/// on wasm32.
#[inline]
fn wrap_degrees(deg: f32) -> f32 {
    deg - 360.0 * (deg / 360.0).floor()
}

fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d < 1e-6 {
        return (0.0, 0.0, l);
    }
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        let v = (g - b) / d;
        if v < 0.0 { v + 6.0 } else { v }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0, s, l)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    if s <= 0.0 {
        return (l, l, l);
    }
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = wrap_degrees(h) / 60.0;
    let x = c * (1.0 - (hp - 2.0 * (hp / 2.0).floor() - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    (r + m, g + m, b + m)
}

/// Interpolation weights of the two band centres surrounding `hue`.
fn band_weights(hue: f32) -> [(usize, f32); 2] {
    let h = wrap_degrees(hue);
    for i in 0..BANDS {
        let lo = BAND_CENTRES[i];
        let hi = if i + 1 < BANDS {
            BAND_CENTRES[i + 1]
        } else {
            360.0
        };
        if h >= lo && h < hi {
            let t = (h - lo) / (hi - lo);
            return [(i, 1.0 - t), ((i + 1) % BANDS, t)];
        }
    }
    [(0, 1.0), (1, 0.0)]
}

struct ColorParams {
    mixer: bool,
    hue: [f32; BANDS],
    sat: [f32; BANDS],
    lum: [f32; BANDS],
    saturation: f32,
    vibrance: f32,
    mono: bool,
}

impl ColorParams {
    fn new(d: &Develop) -> Self {
        ColorParams {
            mixer: !d.mixer_is_identity(),
            hue: d.mixer_hue.map(|v| v / 100.0 * 30.0),
            sat: d.mixer_saturation.map(|v| v / 100.0),
            lum: d.mixer_luminance.map(|v| v / 100.0),
            saturation: d.saturation / 100.0,
            vibrance: d.vibrance / 100.0,
            mono: d.monochrome,
        }
    }

    #[inline]
    fn apply(&self, mut r: f32, mut g: f32, mut b: f32) -> (f32, f32, f32) {
        if self.mixer {
            let (h, s, l) = rgb_to_hsl(r, g, b);
            if s > 1e-4 {
                let [(i, wi), (j, wj)] = band_weights(h);
                let dh = wi * self.hue[i] + wj * self.hue[j];
                let ds = wi * self.sat[i] + wj * self.sat[j];
                let dl = wi * self.lum[i] + wj * self.lum[j];
                let s2 = (s * (1.0 + ds)).clamp(0.0, 1.0);
                // Luminance changes scale with saturation so greys are untouched.
                let l2 =
                    (l + dl * 0.3 * s * (1.0 - (2.0 * l - 1.0).abs()).max(0.2)).clamp(0.0, 1.0);
                (r, g, b) = hsl_to_rgb(h + dh, s2, l2);
            }
        }
        if self.saturation != 0.0 || self.vibrance != 0.0 {
            let y = luma(r, g, b);
            let chroma = r.max(g).max(b) - r.min(g).min(b);
            // Vibrance boosts muted colours more than already-saturated ones.
            let k = (1.0 + self.saturation + self.vibrance * (1.0 - chroma).powi(2)).max(0.0);
            r = y + (r - y) * k;
            g = y + (g - y) * k;
            b = y + (b - y) * k;
        }
        if self.mono {
            let y = luma(r, g, b);
            (r, g, b) = (y, y, y);
        }
        (r, g, b)
    }
}

// ---------------------------------------------------------------------------
// Stage 4: local operations on an 8-bit luminance plane.
// ---------------------------------------------------------------------------

fn luma_plane(img: &RgbaImage) -> Vec<u8> {
    let w = img.width() as usize;
    let src = img.as_raw();
    let mut out = vec![0u8; src.len() / 4];
    for_rows(&mut out, w, |y0, band| {
        let px = &src[y0 * w * 4..][..band.len() * 4];
        for (o, p) in band.iter_mut().zip(px.chunks_exact(4)) {
            *o = ((54 * p[0] as u32 + 183 * p[1] as u32 + 19 * p[2] as u32 + 128) >> 8) as u8;
        }
    });
    out
}

/// One horizontal + vertical box-blur pass. Near the edges the window
/// shrinks to the pixels that exist. Rows are independent in the horizontal
/// pass; the vertical pass keeps running column sums within bands of rows,
/// each band starting from its own window, so bands run in parallel.
fn box_blur(src: &[u8], dst: &mut [u8], tmp: &mut [u8], w: usize, h: usize, r: usize) {
    for_rows(tmp, w, |y0, band| {
        let mut prefix = vec![0u32; w + 1];
        for (i, out) in band.chunks_exact_mut(w).enumerate() {
            let row = &src[(y0 + i) * w..][..w];
            for x in 0..w {
                prefix[x + 1] = prefix[x] + row[x] as u32;
            }
            for (x, o) in out.iter_mut().enumerate() {
                let lo = x.saturating_sub(r);
                let hi = (x + r).min(w - 1);
                let n = (hi - lo + 1) as u32;
                *o = ((prefix[hi + 1] - prefix[lo] + n / 2) / n) as u8;
            }
        }
    });
    let tmp = &*tmp;
    let row = |y: usize| &tmp[y * w..(y + 1) * w];
    for_bands(dst, w, (2 * r + 1).max(64), |y0, band| {
        let mut sums = vec![0u32; w];
        let (lo, hi) = (y0.saturating_sub(r), (y0 + r).min(h - 1));
        for y in lo..=hi {
            for (s, &v) in sums.iter_mut().zip(row(y)) {
                *s += v as u32;
            }
        }
        let mut count = (hi - lo + 1) as u32;
        for (i, out) in band.chunks_exact_mut(w).enumerate() {
            let y = y0 + i;
            for (o, &s) in out.iter_mut().zip(&sums) {
                *o = ((s + count / 2) / count) as u8;
            }
            if y + r + 1 < h {
                for (s, &v) in sums.iter_mut().zip(row(y + r + 1)) {
                    *s += v as u32;
                }
                count += 1;
            }
            if y >= r {
                for (s, &v) in sums.iter_mut().zip(row(y - r)) {
                    *s -= v as u32;
                }
                count -= 1;
            }
        }
    });
}

/// Approximates a Gaussian blur of standard deviation `sigma`.
fn gaussian_like(src: &[u8], w: usize, h: usize, sigma: f32) -> Vec<u8> {
    if sigma < 1.2 {
        // A single separable [1 2 1] pass (sigma ≈ 0.7) for fine sharpening.
        let mut tmp = vec![0u8; src.len()];
        for_rows(&mut tmp, w, |y0, band| {
            for (i, out) in band.chunks_exact_mut(w).enumerate() {
                let row = &src[(y0 + i) * w..][..w];
                for x in 0..w {
                    let l = row[x.saturating_sub(1)] as u32;
                    let r = row[(x + 1).min(w - 1)] as u32;
                    out[x] = ((l + 2 * row[x] as u32 + r + 2) / 4) as u8;
                }
            }
        });
        let mut out = vec![0u8; src.len()];
        let tmp = &tmp;
        for_rows(&mut out, w, |y0, band| {
            for (i, o_row) in band.chunks_exact_mut(w).enumerate() {
                let y = y0 + i;
                let up = &tmp[y.saturating_sub(1) * w..][..w];
                let mid = &tmp[y * w..][..w];
                let down = &tmp[(y + 1).min(h - 1) * w..][..w];
                for (x, o) in o_row.iter_mut().enumerate() {
                    *o = ((up[x] as u32 + 2 * mid[x] as u32 + down[x] as u32 + 2) / 4) as u8;
                }
            }
        });
        return out;
    }
    // Three box passes; r(r + 1) ≈ sigma².
    let r = (((1.0 + 4.0 * sigma * sigma).sqrt() - 1.0) / 2.0)
        .round()
        .max(1.0) as usize;
    let mut a = src.to_vec();
    let mut b = vec![0u8; src.len()];
    let mut tmp = vec![0u8; src.len()];
    for _ in 0..3 {
        box_blur(&a, &mut b, &mut tmp, w, h, r);
        std::mem::swap(&mut a, &mut b);
    }
    a
}

/// Adds `delta(luma, blurred)` to every colour channel.
fn add_luma_delta(
    img: &mut RgbaImage,
    luma: &[u8],
    blurred: &[u8],
    f: impl Fn(f32, f32) -> f32 + Sync + Send,
) {
    let w = img.width() as usize;
    for_rows(img.as_mut(), w * 4, |y0, band| {
        let start = y0 * w;
        for ((p, &l), &bl) in band
            .chunks_exact_mut(4)
            .zip(&luma[start..])
            .zip(&blurred[start..])
        {
            let d = f(l as f32, bl as f32);
            if d != 0.0 {
                for c in &mut p[..3] {
                    *c = (*c as f32 + d).round_ties_even().clamp(0.0, 255.0) as u8;
                }
            }
        }
    });
}

/// Blurs the colour channels (alpha is kept) with a Gaussian-like filter whose
/// radius is relative to the image, so previews and exports match.
fn blur(img: &mut RgbaImage, amount: f32) {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let sigma = (w.max(h) as f32 * 0.02 * amount).max(0.5);
    let mut plane = vec![0u8; w * h];
    for c in 0..3 {
        let src = img.as_raw();
        for_rows(&mut plane, w, |y0, band| {
            for (v, p) in band.iter_mut().zip(src[y0 * w * 4..].chunks_exact(4)) {
                *v = p[c];
            }
        });
        let blurred = gaussian_like(&plane, w, h, sigma);
        for_rows(img.as_mut(), w * 4, |y0, band| {
            for (p, &v) in band.chunks_exact_mut(4).zip(&blurred[y0 * w..]) {
                p[c] = v;
            }
        });
    }
}

fn clarity(img: &mut RgbaImage, amount: f32) {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let l = luma_plane(img);
    let sigma = (w.max(h) as f32 * 0.01).max(2.0);
    let bl = gaussian_like(&l, w, h, sigma);
    add_luma_delta(img, &l, &bl, |l, b| {
        // Strongest in the midtones, fading out towards black and white.
        let m = 1.0 - (2.0 * l / 255.0 - 1.0).powi(2);
        (l - b) * amount * 0.8 * m
    });
}

fn sharpen(img: &mut RgbaImage, amount: f32, radius: f32) {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let l = luma_plane(img);
    let bl = gaussian_like(&l, w, h, radius);
    add_luma_delta(img, &l, &bl, |l, b| {
        let d = l - b;
        // Small threshold so flat areas and noise are not amplified.
        if d.abs() < 2.0 { 0.0 } else { d * amount }
    });
}

// ---------------------------------------------------------------------------
// Stage 5: vignette and grain.
// ---------------------------------------------------------------------------

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn vignette(img: &mut RgbaImage, amount: f32, midpoint: f32) {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let e0 = midpoint * 0.9;
    let e1 = e0 + 0.6;
    // Factor as a function of r² in [0, 1], sampled finely enough for 8-bit output.
    const N: usize = 2048;
    let lut: Vec<f32> = (0..=N)
        .map(|i| smoothstep(e0, e1, (i as f32 / N as f32).sqrt()) * amount * 0.8)
        .collect();
    let nx2: Vec<f32> = (0..w)
        .map(|x| ((x as f32 + 0.5 - cx) / cx).powi(2))
        .collect();
    for_rows(img.as_mut(), w * 4, |y0, band| {
        for (i, row) in band.chunks_exact_mut(w * 4).enumerate() {
            let ny2 = (((y0 + i) as f32 + 0.5 - cy) / cy).powi(2);
            for (p, &nx) in row.chunks_exact_mut(4).zip(&nx2) {
                let f = lut[(((nx + ny2) / 2.0).min(1.0) * N as f32) as usize];
                if f == 0.0 {
                    continue;
                }
                for c in &mut p[..3] {
                    let v = *c as f32;
                    let out = if f < 0.0 {
                        v * (1.0 + f)
                    } else {
                        v + (255.0 - v) * f
                    };
                    *c = (out + 0.5).clamp(0.0, 255.0) as u8;
                }
            }
        }
    });
}

fn grain(img: &mut RgbaImage, amount: f32) {
    let w = img.width() as usize;
    let scale = amount * 40.0 / 32_767.5;
    for_rows(img.as_mut(), w * 4, |y0, band| {
        for (i, row) in band.chunks_exact_mut(w * 4).enumerate() {
            let hy = ((y0 + i) as u32).wrapping_mul(0x85EB_CA77);
            for (x, p) in row.chunks_exact_mut(4).enumerate() {
                // Deterministic hash noise so previews and exports agree.
                let mut n = (x as u32).wrapping_mul(0x9E37_79B1) ^ hy;
                n ^= n >> 15;
                n = n.wrapping_mul(0x2C1B_3C6D);
                n ^= n >> 12;
                let noise = (n & 0xFFFF) as f32 * scale - amount * 40.0;
                for c in &mut p[..3] {
                    *c = (*c as f32 + noise).round_ties_even().clamp(0.0, 255.0) as u8;
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------

pub(super) fn develop(mut img: RgbaImage, d: &Develop) -> Result<RgbaImage> {
    d.validate()?;
    if d.is_identity() {
        return Ok(img);
    }
    let tone = (!d.tone_is_identity()).then(|| tone_tables(d));
    let color = (!d.color_is_identity()).then(|| ColorParams::new(d));
    if let (Some(t), None) = (&tone, &color) {
        // Tone only: everything is per channel, so map u8 -> u8 directly.
        let lut8: [[u8; 256]; 3] =
            std::array::from_fn(|c| std::array::from_fn(|v| (t.lut[c][v] * 255.0 + 0.5) as u8));
        let w = img.width() as usize;
        for_rows(img.as_mut(), w * 4, |_, band| {
            for p in band.chunks_exact_mut(4) {
                p[0] = lut8[0][p[0] as usize];
                p[1] = lut8[1][p[1] as usize];
                p[2] = lut8[2][p[2] as usize];
            }
        });
    } else if tone.is_some() || color.is_some() {
        let w = img.width() as usize;
        for_rows(img.as_mut(), w * 4, |_, band| {
            for p in band.chunks_exact_mut(4) {
                let (mut r, mut g, mut b) = match &tone {
                    Some(t) => (t.apply(0, p[0]), t.apply(1, p[1]), t.apply(2, p[2])),
                    None => (
                        p[0] as f32 / 255.0,
                        p[1] as f32 / 255.0,
                        p[2] as f32 / 255.0,
                    ),
                };
                if let Some(c) = &color {
                    (r, g, b) = c.apply(r, g, b);
                }
                p[0] = (r * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
                p[1] = (g * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
                p[2] = (b * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
            }
        });
    }
    if d.blur > 0.0 {
        blur(&mut img, d.blur / 100.0);
    }
    if d.clarity != 0.0 {
        clarity(&mut img, d.clarity / 100.0);
    }
    if d.sharpen_amount > 0.0 {
        sharpen(&mut img, d.sharpen_amount / 100.0, d.sharpen_radius);
    }
    if d.vignette != 0.0 {
        vignette(&mut img, d.vignette / 100.0, d.vignette_midpoint / 100.0);
    }
    if d.grain > 0.0 {
        grain(&mut img, d.grain / 100.0);
    }
    Ok(img)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// Reference box blur: a direct average over the clipped window.
    fn naive_box_blur(src: &[u8], w: usize, h: usize, r: usize) -> Vec<u8> {
        let avg = |vals: &mut dyn Iterator<Item = u32>| {
            let (mut sum, mut n) = (0u32, 0u32);
            for v in vals {
                sum += v;
                n += 1;
            }
            ((sum + n / 2) / n) as u8
        };
        let mut tmp = vec![0u8; src.len()];
        for y in 0..h {
            for x in 0..w {
                tmp[y * w + x] = avg(&mut (x.saturating_sub(r)..=(x + r).min(w - 1))
                    .map(|xx| src[y * w + xx] as u32));
            }
        }
        let mut out = vec![0u8; src.len()];
        for y in 0..h {
            for x in 0..w {
                out[y * w + x] = avg(&mut (y.saturating_sub(r)..=(y + r).min(h - 1))
                    .map(|yy| tmp[yy * w + x] as u32));
            }
        }
        out
    }

    #[test]
    fn box_blur_matches_a_direct_average_for_any_band_split() {
        // Sizes and radii chosen so bands of rows end inside, at and beyond the window.
        for (w, h, r) in [
            (7, 5, 1),
            (13, 200, 3),
            (31, 130, 40),
            (64, 300, 2),
            (5, 65, 64),
            (9, 1000, 7),
        ] {
            let src: Vec<u8> = (0..w * h).map(|i| ((i * 37 + i / 7) % 251) as u8).collect();
            let (mut dst, mut tmp) = (vec![0u8; w * h], vec![0u8; w * h]);
            box_blur(&src, &mut dst, &mut tmp, w, h, r);
            assert_eq!(dst, naive_box_blur(&src, w, h, r), "{w}x{h} r={r}");
        }
    }

    fn solid(c: [u8; 3]) -> RgbaImage {
        RgbaImage::from_pixel(8, 8, Rgba([c[0], c[1], c[2], 200]))
    }

    fn px(img: &RgbaImage) -> [u8; 4] {
        img.get_pixel(4, 4).0
    }

    fn run(c: [u8; 3], d: Develop) -> [u8; 4] {
        px(&develop(solid(c), &d).unwrap())
    }

    fn gradient() -> RgbaImage {
        RgbaImage::from_fn(64, 64, |x, y| {
            Rgba([(x * 4) as u8, (y * 4) as u8, ((x + y) * 2) as u8, 255])
        })
    }

    #[test]
    fn identity_is_exact_noop() {
        let img = gradient();
        assert_eq!(develop(img.clone(), &Develop::default()).unwrap(), img);
    }

    #[test]
    fn tone_path_at_neutral_settings_is_near_lossless() {
        // A negligible exposure change forces the lookup-table path; it must
        // not visibly alter any value.
        let d = Develop {
            exposure: 0.001,
            ..Default::default()
        };
        let img = gradient();
        let out = develop(img.clone(), &d).unwrap();
        let max = img
            .as_raw()
            .iter()
            .zip(out.as_raw())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(max <= 2, "max diff {max}");
    }

    #[test]
    fn exposure_brightens_and_darkens_by_stops() {
        let up = run(
            [60, 60, 60],
            Develop {
                exposure: 1.0,
                ..Default::default()
            },
        );
        let down = run(
            [60, 60, 60],
            Develop {
                exposure: -1.0,
                ..Default::default()
            },
        );
        assert!(up[0] > 75 && down[0] < 50, "{up:?} {down:?}");
        // One stop doubles linear light: sRGB 60 (lin 0.045) -> lin 0.09 ≈ sRGB 84.
        assert!((up[0] as i32 - 84).abs() <= 3, "{up:?}");
        assert_eq!(up[3], 200, "alpha untouched");
    }

    #[test]
    fn contrast_spreads_tones_around_mid_grey() {
        let d = Develop {
            contrast: 100.0,
            ..Default::default()
        };
        assert!(run([60, 60, 60], d)[0] < 60);
        assert!(run([200, 200, 200], d)[0] > 200);
        let mid = run([128, 128, 128], d)[0];
        assert!((mid as i32 - 128).abs() <= 2);
    }

    #[test]
    fn shadows_highlights_whites_blacks_target_their_ranges() {
        let s = Develop {
            shadows: 100.0,
            ..Default::default()
        };
        assert!(run([50, 50, 50], s)[0] > 60);
        assert!((run([230, 230, 230], s)[0] as i32 - 230).abs() <= 3);

        let h = Develop {
            highlights: -100.0,
            ..Default::default()
        };
        assert!(run([210, 210, 210], h)[0] < 200);
        assert!((run([40, 40, 40], h)[0] as i32 - 40).abs() <= 3);

        assert!(
            run(
                [5, 5, 5],
                Develop {
                    blacks: -100.0,
                    ..Default::default()
                }
            )[0] < 5
        );
        assert!(
            run(
                [5, 5, 5],
                Develop {
                    blacks: 100.0,
                    ..Default::default()
                }
            )[0] > 15
        );
        assert_eq!(
            run(
                [240, 240, 240],
                Develop {
                    whites: 100.0,
                    ..Default::default()
                }
            )[0],
            255
        );
    }

    #[test]
    fn highlights_recover_overexposure() {
        let blown = Develop {
            exposure: 1.5,
            ..Default::default()
        };
        let recovered = Develop {
            exposure: 1.5,
            highlights: -100.0,
            ..Default::default()
        };
        let a = run([180, 180, 180], blown)[0];
        let b = run([180, 180, 180], recovered)[0];
        assert_eq!(a, 255);
        assert!(b < 250, "{b}");
    }

    #[test]
    fn temperature_and_tint_shift_balance() {
        let warm = run(
            [128, 128, 128],
            Develop {
                temperature: 100.0,
                ..Default::default()
            },
        );
        assert!(warm[0] > warm[2] + 20, "{warm:?}");
        let cool = run(
            [128, 128, 128],
            Develop {
                temperature: -100.0,
                ..Default::default()
            },
        );
        assert!(cool[2] > cool[0] + 20, "{cool:?}");
        let magenta = run(
            [128, 128, 128],
            Develop {
                tint: 100.0,
                ..Default::default()
            },
        );
        assert!(
            magenta[1] < magenta[0] && magenta[1] < magenta[2],
            "{magenta:?}"
        );
    }

    #[test]
    fn saturation_vibrance_and_monochrome() {
        let c = [180, 100, 80];
        let gray = run(
            c,
            Develop {
                saturation: -100.0,
                ..Default::default()
            },
        );
        assert!(
            gray[0].abs_diff(gray[1]) <= 1 && gray[1].abs_diff(gray[2]) <= 1,
            "{gray:?}"
        );
        let more = run(
            c,
            Develop {
                saturation: 50.0,
                ..Default::default()
            },
        );
        assert!(more[0] > 180 && more[2] < 80, "{more:?}");
        let vib = run(
            c,
            Develop {
                vibrance: 100.0,
                ..Default::default()
            },
        );
        assert!(vib[0] > 180, "{vib:?}");
        let mono = run(
            c,
            Develop {
                monochrome: true,
                ..Default::default()
            },
        );
        assert!(mono[0] == mono[1] && mono[1] == mono[2]);
        // Muted colours get a bigger vibrance boost than saturated ones.
        let muted = run(
            [140, 120, 110],
            Develop {
                vibrance: 100.0,
                ..Default::default()
            },
        );
        let vivid = run(
            [250, 30, 20],
            Develop {
                vibrance: 100.0,
                ..Default::default()
            },
        );
        assert!(muted[0] - 140 >= vivid[0].saturating_sub(250));
    }

    #[test]
    fn mixer_targets_only_its_band() {
        let mut d = Develop::default();
        d.mixer_saturation[5] = -100.0; // blue
        let blue = run([40, 40, 220], d); // hue 240°, the blue band centre
        assert!(blue[0].abs_diff(blue[2]) < 20, "blue desaturated: {blue:?}");
        let red = run([220, 40, 40], d);
        assert!(red[0] > 200 && red[1] < 60, "red untouched: {red:?}");

        let mut hue = Develop::default();
        hue.mixer_hue[0] = 100.0; // red -> towards orange
        let shifted = run([220, 40, 40], hue);
        assert!(shifted[1] > 60, "{shifted:?}");

        let mut lum = Develop::default();
        lum.mixer_luminance[3] = -100.0; // green
        let g = run([60, 200, 60], lum);
        assert!(g[1] < 190, "{g:?}");
        assert_eq!(run([128, 128, 128], lum)[0], 128, "greys untouched");
    }

    #[test]
    fn hsl_round_trip() {
        for c in [
            (0.2, 0.4, 0.6),
            (0.9, 0.1, 0.3),
            (0.5, 0.5, 0.5),
            (1.0, 1.0, 0.0),
        ] {
            let (h, s, l) = rgb_to_hsl(c.0, c.1, c.2);
            let (r, g, b) = hsl_to_rgb(h, s, l);
            assert!(
                (r - c.0).abs() < 1e-4 && (g - c.1).abs() < 1e-4 && (b - c.2).abs() < 1e-4,
                "{c:?}"
            );
        }
    }

    #[test]
    fn clarity_and_sharpen_increase_local_contrast() {
        // A hard vertical edge: local-contrast operators must overshoot it.
        let img = RgbaImage::from_fn(64, 16, |x, _| {
            let v = if x < 32 { 80 } else { 180 };
            Rgba([v, v, v, 255])
        });
        let range = |i: &RgbaImage| {
            let row: Vec<u8> = (0..64).map(|x| i.get_pixel(x, 8)[0]).collect();
            (*row.iter().min().unwrap(), *row.iter().max().unwrap())
        };
        let sharp = develop(
            img.clone(),
            &Develop {
                sharpen_amount: 150.0,
                ..Default::default()
            },
        )
        .unwrap();
        let (lo, hi) = range(&sharp);
        assert!(lo < 80 && hi > 180, "sharpen {lo}..{hi}");
        let clear = develop(
            img.clone(),
            &Develop {
                clarity: 100.0,
                ..Default::default()
            },
        )
        .unwrap();
        let (lo, hi) = range(&clear);
        assert!(lo < 80 && hi > 180, "clarity {lo}..{hi}");
        // Flat areas stay flat.
        let flat = develop(
            solid([100, 100, 100]),
            &Develop {
                sharpen_amount: 150.0,
                clarity: 100.0,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(flat.pixels().all(|p| p[0] == 100));
    }

    #[test]
    fn blur_softens_edges_and_keeps_flat_areas() {
        let img = RgbaImage::from_fn(64, 16, |x, _| {
            let v = if x < 32 { 0 } else { 255 };
            Rgba([v, v, v, 200])
        });
        let out = develop(
            img,
            &Develop {
                blur: 50.0,
                ..Default::default()
            },
        )
        .unwrap();
        let edge = out.get_pixel(31, 8)[0];
        assert!(edge > 20 && edge < 235, "edge softened: {edge}");
        assert_eq!(out.get_pixel(2, 8)[0], 0, "far from the edge stays flat");
        assert_eq!(out.get_pixel(40, 8)[3], 200, "alpha untouched");
        assert!(
            develop(
                RgbaImage::new(2, 2),
                &Develop {
                    blur: 101.0,
                    ..Default::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn vignette_darkens_corners_not_centre() {
        let img = RgbaImage::from_pixel(100, 60, Rgba([150, 150, 150, 255]));
        let out = develop(
            img,
            &Develop {
                vignette: -100.0,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(out.get_pixel(0, 0)[0] < 80);
        assert_eq!(out.get_pixel(50, 30)[0], 150);
        let img = RgbaImage::from_pixel(100, 60, Rgba([150, 150, 150, 255]));
        let light = develop(
            img,
            &Develop {
                vignette: 100.0,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(light.get_pixel(0, 0)[0] > 200);
    }

    #[test]
    fn grain_is_deterministic_and_bounded() {
        let d = Develop {
            grain: 50.0,
            ..Default::default()
        };
        let a = develop(solid([128, 128, 128]), &d).unwrap();
        let b = develop(solid([128, 128, 128]), &d).unwrap();
        assert_eq!(a, b);
        assert!(a.pixels().any(|p| p[0] != 128));
        assert!(a.pixels().all(|p| p[0].abs_diff(128) <= 21 && p[3] == 200));
    }

    #[test]
    fn rejects_out_of_range() {
        let mut bad = Develop {
            exposure: 6.0,
            ..Default::default()
        };
        assert!(develop(solid([0, 0, 0]), &bad).is_err());
        bad = Develop {
            sharpen_radius: 0.1,
            ..Default::default()
        };
        assert!(develop(solid([0, 0, 0]), &bad).is_err());
        let mut m = Develop::default();
        m.mixer_hue[2] = f32::NAN;
        assert!(develop(solid([0, 0, 0]), &m).is_err());
    }

    #[test]
    fn deserializes_partial_json() {
        let d: Develop =
            serde_json::from_str(r#"{"exposure":1,"mixerHue":[0,10,0,0,0,0,0,0]}"#).unwrap();
        assert_eq!(d.exposure, 1.0);
        assert_eq!(d.mixer_hue[1], 10.0);
        assert_eq!(d.sharpen_radius, 1.0);
        assert_eq!(d.vignette_midpoint, 50.0);
    }
}
