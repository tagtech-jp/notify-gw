import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createFakeD1 } from "./helpers/fakeD1";
import { insertEvent } from "../src/lib/db";
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

describe("/digest/preview と /digest/run の整合性", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T01:00:00Z")); // JST 2026-09-10 10:00
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preview の本文と run が実際に送信する本文が完全一致する(LLMを介さないSQL集計のみ)", async () => {
    const env = makeEnv();
    // 前日(JST 2026-09-09)のイベントを投入
    await insertEvent(env.NOTIFY_DB, {
      ts: "2026-09-09T03:00:00.000Z",
      agent_id: "tagtech-cron",
      action: "job-ok",
      result: "success",
      severity: "INFO",
      fingerprint: "fp-ok",
    });
    await insertEvent(env.NOTIFY_DB, {
      ts: "2026-09-09T04:00:00.000Z",
      agent_id: "tagtech-cron",
      action: "job-failed",
      target: "TypeError: boom",
      result: "failure",
      severity: "CRITICAL",
      fingerprint: "fp-fail",
    });

    const previewRes = await worker.fetch(
      new Request("https://notify-gw.test/digest/preview?date=2026-09-09", { headers: { "x-run-key": "test-run-key" } }),
      env,
    );
    const previewBody = await previewRes.text();

    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const runRes = await worker.fetch(
      new Request("https://notify-gw.test/digest/run", { method: "POST", headers: { "x-run-key": "test-run-key" } }),
      env,
    );
    expect(runRes.status).toBe(200);

    const sentBody = JSON.parse(
      ((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { content: string };

    expect(sentBody.content).toBe(previewBody);
    expect(previewBody).toContain("実行: 2 件 | ✅ 1 | ❌ 1 | ⏭ 0 | 🔴 CRITICAL 1");
    expect(previewBody).toContain("生成LLM不使用");
  });
});
