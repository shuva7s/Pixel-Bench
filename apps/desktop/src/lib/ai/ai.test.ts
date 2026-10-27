import { describe, expect, it } from "vitest";

import { MODELS } from "./models";
import { upscaleProblem } from "./upscale";

describe("AI tools", () => {
  it("lists every model with a licence and pinned size", () => {
    for (const m of Object.values(MODELS)) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.bytes).toBeGreaterThan(1_000_000);
      expect(m.license).not.toBe("");
    }
  });

  it("enforces the 50 MP upscale limit", () => {
    expect(upscaleProblem(2000, 1500, 4)).toBeNull(); // 48 MP
    expect(upscaleProblem(2000, 2000, 4)).toMatch(/50 MP/); // 64 MP
  });
});
