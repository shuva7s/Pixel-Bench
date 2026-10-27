import { describe, expect, it } from "vitest";

import { parseSize } from "./target";

describe("target file size", () => {
  it("parses units (KB = 1024 bytes)", () => {
    expect(parseSize(200, "KB")).toBe(204_800);
    expect(parseSize(1.5, "MB")).toBe(1_572_864);
  });
});
