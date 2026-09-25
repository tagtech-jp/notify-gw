import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createFakeD1 } from "./helpers/fakeD1";
import type { Env } from "../src/types";

function makeEnv(): Env {
  return {
    NOTIFY_DB: createFakeD1(),
    RUN_KEY: "test-run-key",
    DISCORD_WEBHOOK_ALERTS: "https://discord.test/alerts",
    DISCORD_WEBHOOK_DIGEST: "https://discord.test/digest",
    MENTION_USER_ID: "12345",
    TZ_OFFSET_HOURS: "9",
    FLOOD_WINDOW_MIN: "30",
    DIGEST_HOUR_JST: "9",
  };
}

const AUTH = { headers: { "x-run-key": "test-run-key" } };

describe("GET /digest/status (外部死活監視用)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T01:00:00Z")); // JST 2026-09-10 10:00 → 前日 = 2026-09-09
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("requires auth", async () => {
    const res = await worker.fetch(new Request("https://notify-gw.test/digest/status"), makeEnv());
    expect(res.status).toBe(403);
  });

  it("reports sent:false before the digest has run (defaults to previous JST day)", async () => {
    const res = await worker.fetch(new Request("https://notify-gw.test/digest/status", AUTH), makeEnv());
    const data = (await res.json()) as { date_jst: string; sent: boolean; discord_ok: number };
    expect(data.date_jst).toBe("2026-09-09");
    expect(data.sent).toBe(false);
    expect(data.discord_ok).toBe(0);
  });

  it("reports sent:true after a successful /digest/run", async () => {
    const env = makeEnv();
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await worker.fetch(new Request("https://notify-gw.test/digest/run", { method: "POST", ...AUTH }), env);

    const res = await worker.fetch(new Request("https://notify-gw.test/digest/status?date=2026-09-09", AUTH), env);
    const data = (await res.json()) as { sent: boolean; sent_at: string | null; discord_ok: number };
    expect(data.sent).toBe(true);
    expect(data.discord_ok).toBe(1);
    expect(data.sent_at).not.toBeNull();
  });

  it("reports sent:false when Discord delivery failed even though the digest ran", async () => {
    const env = makeEnv();
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    await worker.fetch(new Request("https://notify-gw.test/digest/run", { method: "POST", ...AUTH }), env);

    const res = await worker.fetch(new Request("https://notify-gw.test/digest/status?date=2026-09-09", AUTH), env);
    const data = (await res.json()) as { sent: boolean; discord_ok: number };
    expect(data.sent).toBe(false);
    expect(data.discord_ok).toBe(0);
  });
});
