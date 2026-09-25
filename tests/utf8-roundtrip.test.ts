import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createFakeD1 } from "./helpers/fakeD1";
import type { Env } from "../src/types";

/**
 * 2026-09-10 の実機事故(id=2,3)の再発防止テスト。
 *
 * 事故の原因は Worker コードではなく、Git Bash から日本語をインラインで curl に渡した際に
 * Windows コンソールの cp932 でシェル引数が再エンコードされ、Worker の request.json() が
 * それを不正な UTF-8 バイト列として U+FFFD(復元不能)に置換したこと
 * (feedback_powershell_japanese_encoding.md 参照)。
 *
 * このテストは「Worker が正しい UTF-8 バイト列を受け取れば正しく保存・出力する」ことを
 * 固定して証明する。原因は入口(シェル)側にあるため、運用手順(必ずファイル経由で
 * --data-binary @file.json を使う)側の対策と対にして初めて再発防止になる。
 */

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

const JAPANESE_TEXT = "日本語の要約が正しく保存されるか確認(1回限り)";

describe("UTF-8 往復(実機事故 id=2,3 の再発防止)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("正しいUTF-8バイト列で送られた日本語は target に一切化けずに保存される", async () => {
    const env = makeEnv();
    // Node の Buffer.from(str, "utf-8") が生成する正しいバイト列をそのまま body にする。
    // これは curl --data-binary @file.json と等価(シェルの文字コード変換を経由しない)。
    const body = Buffer.from(
      JSON.stringify({
        agent_id: "test-agent",
        action: "utf8-check",
        target: JAPANESE_TEXT,
        result: "success",
        severity: "INFO",
      }),
      "utf-8",
    );

    const res = await worker.fetch(
      new Request("https://notify-gw.test/event", {
        method: "POST",
        headers: { "x-run-key": "test-run-key", "content-type": "application/json; charset=utf-8" },
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);

    const row = await env.NOTIFY_DB.prepare("SELECT target FROM events WHERE action = 'utf8-check'")
      .first<{ target: string }>();
    expect(row?.target).toBe(JAPANESE_TEXT);
    expect(row?.target.includes("�")).toBe(false);
  });

  it("日本語を含むダイジェストも文字化けせずにDiscord送信本文へ渡る", async () => {
    const env = makeEnv();

    // 「前日」にイベントを投入してから「当日」にダイジェストを実行する(digest-run.test.ts と同型)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T03:00:00Z")); // JST 2026-09-09 12:00
    await worker.fetch(
      new Request("https://notify-gw.test/event", {
        method: "POST",
        headers: { "x-run-key": "test-run-key", "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({
            agent_id: "test-agent",
            action: "job-failed",
            target: JAPANESE_TEXT,
            result: "failure",
            severity: "CRITICAL",
          }),
          "utf-8",
        ),
      }),
      env,
    );
    vi.setSystemTime(new Date("2026-09-10T01:00:00Z")); // JST 2026-09-10 10:00 → 前日 = 2026-09-09

    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const runRes = await worker.fetch(
      new Request("https://notify-gw.test/digest/run", { method: "POST", headers: { "x-run-key": "test-run-key" } }),
      env,
    );
    expect(runRes.status).toBe(200);

    const sentBody = JSON.parse(
      ((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { content: string };
    expect(sentBody.content).toContain(JAPANESE_TEXT);
    expect(sentBody.content.includes("�")).toBe(false);
  });
});
