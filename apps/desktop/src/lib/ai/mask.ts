// Edge settings for background removal. The mask itself is refined and
// composited natively (crates/ai/src/mask.rs).

export interface EdgeSettings {
  /** 0 = the model's soft edge, 100 = a hard cut. */
  hardness: number;
  /** -50..50: negative trims the subject, positive grows it. */
  shift: number;
  /** 0..100: 100 blurs the edge by 1% of the image's long side. */
  feather: number;
}

export const DEFAULT_EDGES: EdgeSettings = { hardness: 0, shift: 0, feather: 0 };
