import { describe, expect, it } from "vitest";
import { dayRangeUtc, jstDateString } from "../src/lib/jst";

describe("jstDateString", () => {
  it("converts a UTC instant to the JST calendar date", () => {
    // UTC 2026-09-09T20:00:00Z -> JST 2026-09-10T05:00:00
    expect(jstDateString(new Date("2026-09-09T20:00:00Z"), 9)).toBe("2026-09-10");
  });

  it("does not roll over when still within the same JST day", () => {
    // UTC 2026-09-09T10:00:00Z -> JST 2026-09-09T19:00:00
    expect(jstDateString(new Date("2026-09-09T10:00:00Z"), 9)).toBe("2026-09-09");
  });
});

describe("dayRangeUtc", () => {
  it("computes the UTC window for a JST calendar day", () => {
    const { startUtc, endUtc } = dayRangeUtc("2026-09-09", 9);
    expect(startUtc).toBe("2026-09-08T15:00:00.000Z");
    expect(endUtc).toBe("2026-09-09T15:00:00.000Z");
  });

  it("produces a 24-hour window", () => {
    const { startUtc, endUtc } = dayRangeUtc("2026-01-01", 9);
    const diffMs = Date.parse(endUtc) - Date.parse(startUtc);
    expect(diffMs).toBe(24 * 60 * 60 * 1000);
  });
});
