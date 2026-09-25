import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCriticalPayload, sendDiscord, truncate } from "../src/lib/discord";

const WEBHOOK = "https://discord.com/api/webhooks/test/token";

function mockFetchOnce(status: number) {
  return vi.fn().mockResolvedValue(new Response(null, { status }));
}

describe("sendDiscord", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok:false without throwing when webhook is not configured", async () => {
    const result = await sendDiscord(undefined, { content: "hi" });
    expect(result).toEqual({ ok: false, error: "webhook_not_configured" });
  });

  it("resolves ok:true on 204", async () => {
    global.fetch = mockFetchOnce(204);
    const result = await sendDiscord(WEBHOOK, { content: "hi" });
    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("sends Content-Type and User-Agent headers", async () => {
    global.fetch = mockFetchOnce(204);
    await sendDiscord(WEBHOOK, { content: "hi" });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe("notify-gw/1.0");
  });

  it("retries once on 5xx and succeeds on the retry", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await sendDiscord(WEBHOOK, { content: "hi" });
    expect(result.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 4xx and fails immediately", async () => {
    global.fetch = mockFetchOnce(400);
    const result = await sendDiscord(WEBHOOK, { content: "hi" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it("never throws, even when fetch rejects twice", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(sendDiscord(WEBHOOK, { content: "hi" })).resolves.toMatchObject({ ok: false });
  });
});

describe("truncate", () => {
  it("leaves short strings untouched", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long strings with an ellipsis, respecting the max length", () => {
    const result = truncate("a".repeat(20), 10);
    expect(result.length).toBe(10);
    expect(result.endsWith("…")).toBe(true);
  });
});

/**
 * 2026-09-18: シグネチャを「要約文字列」から構造化コンテキストへ変更した。
 * 本文に「何が起きたか / どこを見るか / 次にすべきこと」を含めるため
 * (それまでは agent_id と SHA だけで、見ても動けなかった)。
 * テンプレートごとの内容は tests/alert_template.test.ts で固定している。
 */
describe("buildCriticalPayload", () => {
  const ctx = { agentId: "tagtech-cron/job", action: "run", errorKind: "job-failure", eventId: 7 };

  it("includes a mention when mentionUserId is provided", () => {
    const payload = buildCriticalPayload(ctx, "12345");
    expect(payload.content).toContain("<@12345>");
    expect(payload.content).toContain("証跡ID: e-7");
    expect(payload.allowed_mentions).toEqual({ users: ["12345"] });
  });

  it("suppresses all mentions when mentionUserId is absent", () => {
    const payload = buildCriticalPayload(ctx, undefined);
    expect(payload.content).not.toContain("<@");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });
});
