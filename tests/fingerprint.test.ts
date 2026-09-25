import { describe, expect, it } from "vitest";
import { computeFingerprint } from "../src/lib/fingerprint";

describe("computeFingerprint", () => {
  it("is deterministic for identical inputs", async () => {
    const a = await computeFingerprint("tagtech-cron", "job-failed", "TypeError");
    const b = await computeFingerprint("tagtech-cron", "job-failed", "TypeError");
    expect(a).toBe(b);
  });

  it("differs when agent_id differs", async () => {
    const a = await computeFingerprint("tagtech-cron", "job-failed", "TypeError");
    const b = await computeFingerprint("vault-intel", "job-failed", "TypeError");
    expect(a).not.toBe(b);
  });

  it("differs when error_kind differs", async () => {
    const a = await computeFingerprint("tagtech-cron", "job-failed", "TypeError");
    const b = await computeFingerprint("tagtech-cron", "job-failed", "RangeError");
    expect(a).not.toBe(b);
  });

  it("returns a 16-character lowercase hex string", async () => {
    const fp = await computeFingerprint("agent", "action", "kind");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
});
