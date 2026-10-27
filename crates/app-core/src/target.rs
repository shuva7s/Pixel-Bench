//! Bounded search for an output size target. The encoder is injected, so the
//! same logic drives JPEG, lossy WebP, AVIF and lossless formats.
//!
//! - "at most": the largest file that does not exceed the target (the usual
//!   "compress below 200 KB" case).
//! - "at least": the smallest file that reaches the target (some upload forms
//!   require a minimum size). Files are never padded with meaningless bytes;
//!   only quality and, if allowed, dimensions are increased.

use std::collections::HashMap;

use image_core::{EngineError, Result};
use serde::Serialize;

use crate::settings::{TargetMode, TargetSpec};

/// Total encodes allowed (each can take seconds on large images).
pub const MAX_ATTEMPTS: u32 = 16;
const MIN_SCALE: f64 = 0.05;
pub const MAX_SCALE: f64 = 4.0;

#[derive(Debug, Clone)]
pub struct TargetResult<T> {
    pub output: T,
    pub quality: u8,
    /// Linear scale applied to both sides (1 = unchanged).
    pub scale: f64,
    pub met: bool,
    /// Plain-language explanation when the target was not met.
    pub reason: Option<&'static str>,
    pub attempts: u32,
}

/// The summary reported to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetOutcome {
    pub met: bool,
    pub reason: Option<&'static str>,
    pub quality: u8,
    pub scale: f64,
    pub attempts: u32,
}

impl<T> TargetResult<T> {
    pub fn outcome(&self) -> TargetOutcome {
        TargetOutcome {
            met: self.met,
            reason: self.reason,
            quality: self.quality,
            scale: self.scale,
            attempts: self.attempts,
        }
    }
}

/// Anything with a byte length (encoded files; plain sizes in tests).
pub trait HasSize {
    fn size(&self) -> u64;
}

impl HasSize for Vec<u8> {
    fn size(&self) -> u64 {
        self.len() as u64
    }
}

/// A quality and the output it produced.
type Attempt<T> = (u8, T);

struct Search<'a, T, F: FnMut(u8, f64) -> Result<T>> {
    encode: &'a mut F,
    spec: TargetSpec,
    attempts: u32,
    cache: HashMap<(u8, u64), T>,
}

impl<T: Clone + HasSize, F: FnMut(u8, f64) -> Result<T>> Search<'_, T, F> {
    fn ok(&self, size: u64) -> bool {
        match self.spec.mode {
            TargetMode::AtMost => size <= self.spec.bytes,
            TargetMode::AtLeast => size >= self.spec.bytes,
        }
    }

    fn key(q: u8, s: f64) -> (u8, u64) {
        (q, (s * 10_000.0).round() as u64)
    }

    fn run(&mut self, q: u8, s: f64) -> Result<T> {
        if let Some(hit) = self.cache.get(&Self::key(q, s)) {
            return Ok(hit.clone());
        }
        self.attempts += 1;
        let out = (self.encode)(q, s)?;
        self.cache.insert(Self::key(q, s), out.clone());
        Ok(out)
    }

    /// Best quality at `scale` for the target, by binary search. Returns (best, closest).
    fn search_quality(
        &mut self,
        scale: f64,
        extreme_q: u8,
    ) -> Result<(Option<Attempt<T>>, Attempt<T>)> {
        let at_most = self.spec.mode == TargetMode::AtMost;
        let (mut lo, mut hi) = (1i32, 100i32);
        let mut best: Option<(u8, T)> = None;
        let mut closest: Option<(u8, T)> = None;
        let target = self.spec.bytes;
        let consider =
            |q: u8, out: T, ok: bool, best: &mut Option<(u8, T)>, closest: &mut Option<(u8, T)>| {
                let dist = |o: &T| o.size().abs_diff(target);
                if closest.as_ref().is_none_or(|(_, c)| dist(&out) < dist(c)) {
                    *closest = Some((q, out.clone()));
                }
                if ok
                    && best
                        .as_ref()
                        .is_none_or(|(bq, _)| if at_most { q > *bq } else { q < *bq })
                {
                    *best = Some((q, out));
                }
            };
        while lo <= hi && self.attempts < MAX_ATTEMPTS {
            let q = ((lo + hi) as f64 / 2.0).round() as u8;
            let out = self.run(q, scale)?;
            let ok = self.ok(out.size());
            consider(q, out, ok, &mut best, &mut closest);
            // Size grows with quality.
            if at_most == ok {
                lo = i32::from(q) + 1;
            } else {
                hi = i32::from(q) - 1;
            }
        }
        // An already-measured extreme quality is a valid answer if the budget ran out.
        if let Some(extreme) = self.cache.get(&Self::key(extreme_q, scale)).cloned() {
            let ok = self.ok(extreme.size());
            consider(extreme_q, extreme, ok, &mut best, &mut closest);
        }
        Ok((best, closest.expect("at least one encode")))
    }

    /// Finds a scale at which `quality` meets the target. Learns how size grows
    /// with scale (size ∝ scale^k) instead of assuming k = 2: upscaled images,
    /// for example, compress better than their pixel count suggests.
    fn search_scale(&mut self, quality: u8, max_scale: f64) -> Result<Option<f64>> {
        let at_most = self.spec.mode == TargetMode::AtMost;
        let first = self.run(quality, 1.0)?.size();
        if self.ok(first) {
            return Ok(Some(1.0));
        }
        let mut points: Vec<(f64, u64)> = vec![(1.0, first)];
        for _ in 0..6 {
            if self.attempts >= MAX_ATTEMPTS {
                break;
            }
            let (ls, lsize) = *points.last().unwrap();
            let mut k = 2.0;
            if points.len() >= 2 {
                let (ps, psize) = points[points.len() - 2];
                let measured = (lsize as f64 / psize as f64).ln() / (ls / ps).ln();
                if measured.is_finite() && measured > 0.3 {
                    k = measured;
                }
            }
            let guess = ls
                * (self.spec.bytes as f64 / lsize as f64).powf(1.0 / k)
                * if at_most { 0.97 } else { 1.03 };
            let next = guess.clamp(MIN_SCALE, max_scale);
            if (next - ls).abs() < 1e-3 {
                break;
            }
            let size = self.run(quality, next)?.size();
            points.push((next, size));
            if self.ok(size) {
                return Ok(Some(next));
            }
        }
        Ok(None)
    }
}

/// Searches quality (and, if allowed, scale up to `max_scale`) for the target.
pub fn fit_to_target<T, F>(
    mut encode: F,
    spec: TargetSpec,
    lossy: bool,
    max_scale: f64,
) -> Result<TargetResult<T>>
where
    T: Clone + HasSize,
    F: FnMut(u8, f64) -> Result<T>,
{
    if spec.bytes == 0 {
        return Err(EngineError::InvalidOptions(
            "The target size must be greater than 0.".into(),
        ));
    }
    let at_most = spec.mode == TargetMode::AtMost;
    let mut s = Search {
        encode: &mut encode,
        spec,
        attempts: 0,
        cache: HashMap::new(),
    };
    // The quality that gives the most room: lowest when shrinking, highest when growing.
    let extreme_q = if lossy && at_most { 1 } else { 100 };

    let finish = |s: &Search<T, F>, out: T, quality: u8, scale: f64, reason: &'static str| {
        let met = s.ok(out.size());
        TargetResult {
            output: out,
            quality,
            scale,
            met,
            reason: (!met).then_some(reason),
            attempts: s.attempts,
        }
    };

    if lossy {
        let (mut best, mut closest) = s.search_quality(1.0, extreme_q)?;
        let mut scale = 1.0;
        if best.is_none() && spec.allow_resize {
            if let Some(found) = s.search_scale(extreme_q, max_scale)? {
                scale = found;
                (best, closest) = s.search_quality(scale, extreme_q)?;
            }
        }
        let reason = match (at_most, spec.allow_resize) {
            (true, true) => {
                "Even the lowest quality at the smallest allowed size is above the target."
            }
            (true, false) => {
                "Even the lowest quality is above the target. Allow resizing to go smaller."
            }
            (false, true) => {
                "Even the highest quality at the largest allowed size is below the target."
            }
            (false, false) => {
                "Even the highest quality is below the target. Allow enlarging to go bigger."
            }
        };
        let (q, out) = best.unwrap_or(closest);
        return Ok(finish(&s, out, q, scale, reason));
    }

    // Lossless formats have no quality: only dimensions can change.
    if spec.allow_resize {
        if let Some(scale) = s.search_scale(100, max_scale)? {
            let out = s.run(100, scale)?;
            return Ok(finish(&s, out, 100, scale, ""));
        }
    }
    let out = s.run(100, 1.0)?;
    let reason = if spec.allow_resize {
        "The target could not be reached within the allowed size range."
    } else {
        "This format is lossless, so only resizing can change its size. Allow resizing, or choose JPEG, WebP or AVIF."
    };
    Ok(finish(&s, out, 100, 1.0, reason))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A fake "file" that only has a size.
    #[derive(Clone)]
    struct Fake(u64);
    impl HasSize for Fake {
        fn size(&self) -> u64 {
            self.0
        }
    }

    /// Size grows with quality and with pixel count.
    fn fake(base: f64, exp: f64, calls: &Cell<u32>) -> impl FnMut(u8, f64) -> Result<Fake> + '_ {
        move |q, s| {
            calls.set(calls.get() + 1);
            Ok(Fake(
                (base * (0.05 + 0.95 * (f64::from(q) / 100.0).powi(2)) * s.powf(exp)).round()
                    as u64,
            ))
        }
    }

    fn spec(bytes: u64, mode: TargetMode, allow_resize: bool) -> TargetSpec {
        TargetSpec {
            bytes,
            mode,
            allow_resize,
        }
    }

    #[test]
    fn finds_the_highest_quality_under_the_target() {
        let calls = Cell::new(0);
        let r = fit_to_target(
            fake(1e6, 2.0, &calls),
            spec(300_000, TargetMode::AtMost, false),
            true,
            MAX_SCALE,
        )
        .unwrap();
        assert!(r.met);
        assert!(r.output.0 <= 300_000 && r.output.0 > 280_000);
        assert_eq!(r.scale, 1.0);
        assert!(calls.get() <= MAX_ATTEMPTS);
    }

    #[test]
    fn reports_honestly_when_quality_alone_cannot_reach_it() {
        let calls = Cell::new(0);
        let r = fit_to_target(
            fake(1e6, 2.0, &calls),
            spec(10_000, TargetMode::AtMost, false),
            true,
            MAX_SCALE,
        )
        .unwrap();
        assert!(!r.met);
        assert_eq!(r.quality, 1);
        assert!(r.reason.unwrap().contains("Allow resizing"));
    }

    #[test]
    fn shrinks_dimensions_when_allowed() {
        let calls = Cell::new(0);
        let r = fit_to_target(
            fake(1e6, 2.0, &calls),
            spec(10_000, TargetMode::AtMost, true),
            true,
            MAX_SCALE,
        )
        .unwrap();
        assert!(r.met && r.scale < 1.0 && r.output.0 <= 10_000);
    }

    #[test]
    fn reaches_a_minimum_with_the_lowest_sufficient_quality() {
        let calls = Cell::new(0);
        let r = fit_to_target(
            fake(1e6, 2.0, &calls),
            spec(500_000, TargetMode::AtLeast, false),
            true,
            MAX_SCALE,
        )
        .unwrap();
        assert!(r.met && r.output.0 >= 500_000 && r.output.0 < 540_000);
    }

    #[test]
    fn enlarges_only_when_allowed_and_never_pads() {
        let calls = Cell::new(0);
        let no = fit_to_target(
            fake(1e5, 2.0, &calls),
            spec(1_000_000, TargetMode::AtLeast, false),
            true,
            MAX_SCALE,
        )
        .unwrap();
        assert!(!no.met);
        assert_eq!(no.output.0, 100_000);
        let yes = fit_to_target(
            fake(1e5, 2.0, &calls),
            spec(1_000_000, TargetMode::AtLeast, true),
            true,
            MAX_SCALE,
        )
        .unwrap();
        assert!(yes.met && yes.scale > 1.0);
    }

    #[test]
    fn learns_how_size_grows_with_scale() {
        let calls = Cell::new(0);
        let r = fit_to_target(
            fake(40_000.0, 1.2, &calls),
            spec(150_000, TargetMode::AtLeast, true),
            true,
            MAX_SCALE,
        )
        .unwrap();
        assert!(r.met && r.output.0 >= 150_000 && r.attempts <= MAX_ATTEMPTS);
        let far = fit_to_target(
            fake(40_000.0, 1.2, &calls),
            spec(300_000, TargetMode::AtLeast, true),
            true,
            MAX_SCALE,
        )
        .unwrap();
        assert!(!far.met);
        assert!(far.reason.unwrap().contains("largest allowed size"));
        let shrink = fit_to_target(
            fake(40_000.0, 1.2, &calls),
            spec(1_000, TargetMode::AtMost, true),
            true,
            MAX_SCALE,
        )
        .unwrap();
        assert!(shrink.met && shrink.output.0 <= 1_000);
    }

    #[test]
    fn lossless_formats_change_size_only_through_dimensions() {
        let calls = Cell::new(0);
        let no = fit_to_target(
            fake(1e6, 2.0, &calls),
            spec(200_000, TargetMode::AtMost, false),
            false,
            MAX_SCALE,
        )
        .unwrap();
        assert!(!no.met && no.reason.unwrap().contains("lossless"));
        let yes = fit_to_target(
            fake(1e6, 2.0, &calls),
            spec(200_000, TargetMode::AtMost, true),
            false,
            MAX_SCALE,
        )
        .unwrap();
        assert!(yes.met && yes.quality == 100);
    }

    #[test]
    fn rejects_a_zero_target() {
        let calls = Cell::new(0);
        assert!(
            fit_to_target(
                fake(1.0, 2.0, &calls),
                spec(0, TargetMode::AtMost, false),
                true,
                MAX_SCALE
            )
            .is_err()
        );
    }
}
