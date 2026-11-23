// Live proof of REQ-G003 (throwaway branch, never merged): the test that makes coverageLabel pass the gate.
import { describe, expect, it } from "vitest";

const g: any = await import("../scripts/change-gate.mjs");

describe("REQ-G003 live proof: coverageLabel", () => {
  it("formats run/total as a percentage rounded down to one decimal", () => {
    expect(g.coverageLabel(363, 367)).toBe("98.9% (363/367)");
    expect(g.coverageLabel(5, 5)).toBe("100% (5/5)");
  });
  it("reports no changed code lines for an empty or invalid total", () => {
    expect(g.coverageLabel(0, 0)).toBe("no changed code lines");
    expect(g.coverageLabel(1.5, 3)).toBe("no changed code lines");
  });
});
