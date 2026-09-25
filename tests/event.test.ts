import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createFakeD1 } from "./helpers/fakeD1";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTIFY_DB: createFakeD1(),
    RUN_KEY: "test-run-key",
    DISCORD_WEBHOOK_ALERTS: "https://discord.test/alerts",
    DISCORD_WEBHOOK_DIGEST: "https://discord.test/digest",
    MENTION_USER_ID: "12345",
    TZ_OFFSET_HOURS: "9",
    FLOOD_WINDOW_MIN: "30",
    DIGEST_HOUR_JST: "9",
    ...overrides,
  };
}

function postEvent(body: unknown, key = "test-run-key"): Request {
  return new Request("https://notify-gw.test/event", {
    method: "POST",
    headers: { "x-run-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("routing / auth", () => {
  it("returns 404 for unknown paths", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://notify-gw.test/nope"), env);
    expect(res.status).toBe(404);
  });

  it("returns 405 with Allow header for wrong method on /event", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://notify-gw.test/event", { method: "GET" }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("returns 403 when no key is provided", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://notify-gw.test/event", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 when the key is wrong", async () => {
    const env = makeEnv();
    const res = await worker.fetch(postEvent({}, "wrong-key"), env);
    expect(res.status).toBe(403);
  });
});

describe("POST /event", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects invalid JSON with 400", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://notify-gw.test/event", { method: "POST", headers: { "x-run-key": "test-run-key" }, body: "not json" }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a body missing required fields with 400", async () => {
    const env = makeEnv();
    const res = await worker.fetch(postEvent({ agent_id: "a" }), env);
    expect(res.status).toBe(400);
  });

  it("records an INFO success event without sending to Discord", async () => {
    global.fetch = vi.fn();
    const env = makeEnv();
    const res = await worker.fetch(
      postEvent({ agent_id: "tagtech-cron", action: "job-ok", result: "success", severity: "INFO" }),
      env,
    );
    const data = (await res.json()) as { ok: boolean; discord_sent: boolean };
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.discord_sent).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends a CRITICAL event to #alerts with a mention", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const env = makeEnv();
    const res = await worker.fetch(
      postEvent({
        agent_id: "tagtech-cron",
        action: "job-failed",
        target: "TypeError: boom",
        result: "failure",
        severity: "CRITICAL",
      }),
      env,
    );
    const data = (await res.json()) as { discord_sent: boolean; suppressed: boolean };
    expect(data.discord_sent).toBe(true);
    expect(data.suppressed).toBe(false);
    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.test/alerts");
    expect(String(init.body)).toContain("<@12345>");
  });

  it("persists discord_sent/discord_status on the original event row after a successful send (判断2)", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const env = makeEnv();
    const res = await worker.fetch(
      postEvent({ agent_id: "a", action: "job-failed", result: "failure", severity: "CRITICAL" }),
      env,
    );
    const data = (await res.json()) as { id: number };
    const row = await env.NOTIFY_DB.prepare("SELECT discord_sent, discord_status FROM events WHERE id = ?")
      .bind(data.id)
      .first<{ discord_sent: number; discord_status: number }>();
    expect(row?.discord_sent).toBe(1);
    expect(row?.discord_status).toBe(204);
  });

  it("persists discord_sent=0 on the original event row when Discord send fails (判断2)", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const env = makeEnv();
    const res = await worker.fetch(
      postEvent({ agent_id: "a", action: "job-failed", result: "failure", severity: "CRITICAL" }),
      env,
    );
    const data = (await res.json()) as { id: number };
    const row = await env.NOTIFY_DB.prepare("SELECT discord_sent, discord_status FROM events WHERE id = ?")
      .bind(data.id)
      .first<{ discord_sent: number; discord_status: number }>();
    expect(row?.discord_sent).toBe(0);
    expect(row?.discord_status).toBe(400);
  });

  it("does not throw the request when Discord send fails, and records a WARN follow-up event", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const env = makeEnv();
    const res = await worker.fetch(
      postEvent({ agent_id: "a", action: "job-failed", result: "failure", severity: "CRITICAL" }),
      env,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { discord_sent: boolean };
    expect(data.discord_sent).toBe(false);

    // WARN の自己記録が残っていることを確認
    const health = await worker.fetch(
      new Request("https://notify-gw.test/health", { headers: { "x-run-key": "test-run-key" } }),
      env,
    );
    expect(health.status).toBe(200);
  });
});

describe("洪水抑制 (flood suppression)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("suppresses a second CRITICAL event with the same fingerprint within the window", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const env = makeEnv({ FLOOD_WINDOW_MIN: "30" });
    const body = {
      agent_id: "tagtech-cron",
      action: "job-failed",
      target: "same error",
      result: "failure" as const,
      severity: "CRITICAL" as const,
      fingerprint: "fp-fixed",
    };

    const first = await worker.fetch(postEvent(body), env);
    const firstData = (await first.json()) as { discord_sent: boolean; suppressed: boolean };
    expect(firstData.discord_sent).toBe(true);
    expect(firstData.suppressed).toBe(false);

    const second = await worker.fetch(postEvent(body), env);
    const secondData = (await second.json()) as { discord_sent: boolean; suppressed: boolean };
    expect(secondData.discord_sent).toBe(false);
    expect(secondData.suppressed).toBe(true);

    // Discordへは1回しか送っていない(2回目は抑制されている)が、D1には両方記録されている
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("does not suppress CRITICAL events with different fingerprints", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const env = makeEnv();

    await worker.fetch(
      postEvent({ agent_id: "a", action: "job-failed", result: "failure", severity: "CRITICAL", fingerprint: "fp-a" }),
      env,
    );
    await worker.fetch(
      postEvent({ agent_id: "b", action: "job-failed", result: "failure", severity: "CRITICAL", fingerprint: "fp-b" }),
      env,
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("RUN_KEY_MT5 (mt5-trader専用鍵)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts /event when RUN_KEY_MT5 is used with agent_id 'mt5-trader'", async () => {
    const env = makeEnv({ RUN_KEY_MT5: "mt5-secret" });
    const res = await worker.fetch(
      postEvent({ agent_id: "mt5-trader", action: "order-placed", severity: "INFO" }, "mt5-secret"),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("rejects /event when RUN_KEY_MT5 is used with an agent_id other than 'mt5-trader'", async () => {
    const env = makeEnv({ RUN_KEY_MT5: "mt5-secret" });
    const res = await worker.fetch(
      postEvent({ agent_id: "someone-else", action: "order-placed", severity: "INFO" }, "mt5-secret"),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("still authenticates the main RUN_KEY for any agent_id when RUN_KEY_MT5 is also configured", async () => {
    const env = makeEnv({ RUN_KEY_MT5: "mt5-secret" });
    const res = await worker.fetch(
      postEvent({ agent_id: "someone-else", action: "order-placed", severity: "INFO" }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("rejects /event with the RUN_KEY_MT5 value when RUN_KEY_MT5 is unset, no matter the header", async () => {
    const env = makeEnv(); // RUN_KEY_MT5 not set
    const withGuessedKey = await worker.fetch(
      postEvent({ agent_id: "mt5-trader", action: "order-placed", severity: "INFO" }, "mt5-secret"),
      env,
    );
    expect(withGuessedKey.status).toBe(403);

    const withEmptyHeader = await worker.fetch(
      new Request("https://notify-gw.test/event", {
        method: "POST",
        headers: { "x-run-key": "", "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "mt5-trader", action: "order-placed", severity: "INFO" }),
      }),
      env,
    );
    expect(withEmptyHeader.status).toBe(403);

    const withNoHeader = await worker.fetch(
      new Request("https://notify-gw.test/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: "mt5-trader", action: "order-placed", severity: "INFO" }),
      }),
      env,
    );
    expect(withNoHeader.status).toBe(403);
  });

  it("does not accept RUN_KEY_MT5 on endpoints other than /event", async () => {
    const env = makeEnv({ RUN_KEY_MT5: "mt5-secret" });
    const res = await worker.fetch(
      new Request("https://notify-gw.test/health", { headers: { "x-run-key": "mt5-secret" } }),
      env,
    );
    expect(res.status).toBe(403);
  });
});
