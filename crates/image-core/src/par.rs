//! Band-parallel loops over row-major buffers. With the `parallel` feature
//! (native builds) bands of rows run on all cores; without it the same code
//! runs sequentially. Every caller computes each output element from inputs
//! only, so results are identical either way.

/// Rows per band: large enough to amortise scheduling, small enough to balance load.
const BAND_ROWS: usize = 16;

/// Calls `f(first_row, band)` for consecutive bands of `buf`, whose rows are
/// `row_len` elements long.
pub(crate) fn for_bands<T: Send>(
    buf: &mut [T],
    row_len: usize,
    band_rows: usize,
    f: impl Fn(usize, &mut [T]) + Sync + Send,
) {
    if buf.is_empty() || row_len == 0 {
        return;
    }
    let chunk = row_len * band_rows.max(1);
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;
        buf.par_chunks_mut(chunk)
            .enumerate()
            .for_each(|(i, band)| f(i * band_rows.max(1), band));
    }
    #[cfg(not(feature = "parallel"))]
    buf.chunks_mut(chunk)
        .enumerate()
        .for_each(|(i, band)| f(i * band_rows.max(1), band));
}

/// `for_bands` with the default band height.
pub(crate) fn for_rows<T: Send>(
    buf: &mut [T],
    row_len: usize,
    f: impl Fn(usize, &mut [T]) + Sync + Send,
) {
    for_bands(buf, row_len, BAND_ROWS, f);
}
