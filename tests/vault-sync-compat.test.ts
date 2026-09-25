import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createFakeD1 } from "./helpers/fakeD1";
import { auditBindings } from "../src/lib/db";
import type { Env } from "../src/types";

/**
 * WSL の ~/bin/vault-sync-once.sh (別セッション実装・変更しない) が送るペイロードを
 * そのまま受けられることを固定する。
 * 送信元を触らない前提なので、受け口の互換性が壊れたら即ここで落ちる。
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

const AUTH = { "x-run-key": "test-run-key", "content-type": "application/json" };

function post(path: string, body: unknown): Request {
  return new Request(`https://notify-gw.test${path}`, { method: "POST", headers: AUTH, body: JSON.stringify(body) });
}

describe("vault-sync-once.sh との互換(送信元は変更しない)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POST /heartbeat は /bindings/report のエイリアスとして動く(bindings 省略可)", async () => {
    const env = makeEnv();
    // 実際の送信形: {"agent_id":"vault-sync","result":"ok","ts":"..."}
    const res = await worker.fetch(
      post("/heartbeat", { agent_id: "vault-sync", result: "ok", ts: "2026-09-14T09:20:00+09:00" }),
      env,
    );
    expect(res.status).toBe(200);

    // 死活台帳が更新され、drift から消える
    const drifts = await auditBindings(env.NOTIFY_DB, Date.now());
    expect(drifts.find((d) => d.agent_id === "vault-sync")).toBeUndefined();
    // バインディングを持たない agent なので欠落 CRITICAL は出ない
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("POST /event は result 省略 + summary でも受け付ける(CRITICAL は #alerts へ)", async () => {
    const env = makeEnv();
    // 実際の送信形: {"agent_id":"vault-sync","severity":"CRITICAL","action":"sync","summary":"..."}
    const res = await worker.fetch(
      post("/event", {
        agent_id: "vault-sync",
        severity: "CRITICAL",
        action: "sync",
        summary: "rebase衝突。自動解決せず停止。手動対応が必要",
      }),
      env,
    );
    expect(res.status).toBe(200);

    const row = await env.NOTIFY_DB.prepare(
      "SELECT result, severity, target FROM events WHERE agent_id = 'vault-sync'",
    ).first<{ result: string; severity: string; target: string }>();
    // result 省略時は severity から補う。summary は target に入る
    expect(row).toMatchObject({ result: "failure", severity: "CRITICAL" });
    expect(row?.target).toContain("rebase衝突");

    expect(global.fetch).toHaveBeenCalledOnce();
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("https://discord.test/alerts");
  });

  it("result 省略時の既定値は severity から決まる", async () => {
    const env = makeEnv();
    for (const [severity, expected] of [
      ["INFO", "success"],
      ["WARN", "skip"],
    ] as const) {
      await worker.fetch(post("/event", { agent_id: "vault-sync", action: `t-${severity}`, severity }), env);
      const row = await env.NOTIFY_DB.prepare("SELECT result FROM events WHERE action = ?")
        .bind(`t-${severity}`)
        .first<{ result: string }>();
      expect(row?.result).toBe(expected);
    }
  });

  it("未知の agent_id からの heartbeat は 404(誤設定を黙って受けない)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(post("/heartbeat", { agent_id: "typo-agent" }), env);
    expect(res.status).toBe(404);
  });
});

describe("未配線と障害の区別", () => {
  it("一度も申告が無い agent は neverReported=true(日報1行のみ・#alerts に出さない)", async () => {
    const db = createFakeD1();
    const drift = (await auditBindings(db, Date.now())).find((d) => d.agent_id === "vault-sync");
    expect(drift).toMatchObject({ stale: true, neverReported: true, reported_at: null });
  });

  it("一度届いた後に途絶えた agent は neverReported=false(従来どおり WARN 証跡)", async () => {
    const env = makeEnv();
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now - 30 * 3600 * 1000));
    await worker.fetch(post("/heartbeat", { agent_id: "vault-sync" }), env);
    vi.useRealTimers();

    const drift = (await auditBindings(env.NOTIFY_DB, now)).find((d) => d.agent_id === "vault-sync");
    expect(drift).toMatchObject({ stale: true, neverReported: false });
    expect(drift?.reported_at).not.toBeNull();
  });
});
