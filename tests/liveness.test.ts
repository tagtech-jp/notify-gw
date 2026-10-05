import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createFakeD1 } from "./helpers/fakeD1";
import { insertEvent, listUnresolvedCriticals, upsertBindingReport } from "../src/lib/db";
import { LIVENESS_ACTION, parseFastLiveness } from "../src/lib/liveness";
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
    VAULT_REPO: "tagtech-jp/tagtech-vault",
    VAULT_DIGEST_DIR: "digest",
    TOKEN_WARN_DAYS: "14",
    FAST_LIVENESS: "fuwacchi-feed:150",
  };
}

const NOW = Date.parse("2026-10-05T10:00:00.000Z"); // JST 19:00

async function runCron(env: Env, cron = "*/15 * * * *"): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
  await worker.scheduled({ cron, scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, env,
    ctx as unknown as ExecutionContext);
  await Promise.all(pending);
}

async function reportAt(env: Env, msAgo: number): Promise<void> {
  await upsertBindingReport(env.NOTIFY_DB, {
    agentId: "fuwacchi-feed",
    bindings: [],
    missing: [],
    reportedAt: new Date(Date.now() - msAgo).toISOString(),
  });
}

async function livenessEvents(env: Env): Promise<Array<{ result: string; severity: string; target: string }>> {
  const res = await env.NOTIFY_DB.prepare(
    `SELECT result, severity, target FROM events WHERE agent_id = 'fuwacchi-feed' AND action = ? ORDER BY id`,
  )
    .bind(LIVENESS_ACTION)
    .all<{ result: string; severity: string; target: string }>();
  return res.results ?? [];
}

function heartbeat(): Request {
  return new Request("https://notify-gw.test/heartbeat", {
    method: "POST",
    headers: { "x-run-key": "test-run-key", "content-type": "application/json" },
    body: JSON.stringify({ agent_id: "fuwacchi-feed" }),
  });
}

describe("parseFastLiveness", () => {
  it("「agent_id:分」をカンマ区切りで読み、壊れた項目は捨てる", () => {
    const m = parseFastLiveness("fuwacchi-feed:150, vault-sync : 90,bad,x:0,y:abc,");
    expect([...m.entries()]).toEqual([
      ["fuwacchi-feed", 150],
      ["vault-sync", 90],
    ]);
    expect(parseFastLiveness(undefined).size).toBe(0);
  });
});

describe("速い死活監視(15分ごとの cron)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("しきい値を超えたら CRITICAL で #alerts に1回だけ知らせ、申告が戻ったら解消を記録する", async () => {
    const env = makeEnv();
    await reportAt(env, 151 * 60 * 1000);
    await runCron(env);

    let ev = await livenessEvents(env);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ result: "failure", severity: "CRITICAL" });
    expect(ev[0].target).toContain("2時間31分 申告が届いていない");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://discord.test/alerts");
    const content = JSON.parse(init.body).content as string;
    expect(content).toContain("<@12345>");
    expect(content).toContain("生存の知らせが届いていません");
    expect(content).toContain("fuwacchi-feed / liveness-stale");

    // 15分後も途絶したまま: 同じ途絶では2回目を知らせない
    vi.setSystemTime(NOW + 15 * 60 * 1000);
    await runCron(env);
    expect(await livenessEvents(env)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 申告が戻る: success が記録され、未解消一覧から消える
    const res = await worker.fetch(heartbeat(), env);
    expect(res.status).toBe(200);
    ev = await livenessEvents(env);
    expect(ev.map((e) => e.result)).toEqual(["failure", "success"]);
    expect(ev[1].severity).toBe("INFO");
    const unresolved = await listUnresolvedCriticals(env.NOTIFY_DB, new Date(Date.now() + 60_000).toISOString());
    expect(unresolved.filter((u) => u.agent_id === "fuwacchi-feed")).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 解消は #alerts に送らない(#alerts は CRITICAL だけ)

    // 2回目の申告では何も足さない
    await worker.fetch(heartbeat(), env);
    expect(await livenessEvents(env)).toHaveLength(2);

    // 再び途絶したら、また知らせる
    vi.setSystemTime(NOW + 15 * 60 * 1000 + 151 * 60 * 1000);
    await runCron(env);
    ev = await livenessEvents(env);
    expect(ev.map((e) => e.result)).toEqual(["failure", "success", "failure"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("しきい値の内・一度も申告が無い(未配線)・対象外の相手は知らせない", async () => {
    const env = makeEnv();
    await runCron(env); // fuwacchi-feed はまだ一度も申告していない
    await reportAt(env, 149 * 60 * 1000);
    await runCron(env);
    await upsertBindingReport(env.NOTIFY_DB, {
      agentId: "vault-sync",
      bindings: [],
      missing: [],
      reportedAt: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
    });
    await runCron(env); // vault-sync は FAST_LIVENESS に無い(26時間の日報の判定だけ)
    expect(await livenessEvents(env)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("判定が動いた証拠は日本時間の1日に1件だけ残し、FAST_LIVENESS が空なら何もしない", async () => {
    const env = makeEnv();
    await reportAt(env, 10 * 60 * 1000);
    await runCron(env);
    await runCron(env);
    const count = async () =>
      (await env.NOTIFY_DB.prepare(
        `SELECT COUNT(*) AS n FROM events WHERE agent_id = 'notify-gw/liveness' AND action = 'liveness-check'`,
      ).first<{ n: number }>())
        ?.n;
    expect(await count()).toBe(1);
    vi.setSystemTime(Date.parse("2026-10-05T15:30:00.000Z")); // JST 10/06 00:30 = 翌日
    await runCron(env);
    expect(await count()).toBe(2);

    const off = { ...makeEnv(), FAST_LIVENESS: "" };
    await runCron(off);
    expect(
      (await off.NOTIFY_DB.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it("日報の未解消一覧に、同じ途絶を2行(速い判定と26時間の判定)で出さない", async () => {
    const env = makeEnv();
    vi.setSystemTime(Date.parse("2026-10-05T01:00:00.000Z")); // JST 10/05 10:00(日報は 10/04 分)
    await reportAt(env, 30 * 3600 * 1000); // 30時間前が最後の申告 → 26時間の判定でも途絶
    await insertEvent(env.NOTIFY_DB, {
      ts: "2026-10-04T00:00:00.000Z",
      agent_id: "fuwacchi-feed",
      action: LIVENESS_ACTION,
      target: "2時間31分 申告が届いていない",
      result: "failure",
      severity: "CRITICAL",
      fingerprint: "fp-live",
    });
    const res = await worker.fetch(
      new Request("https://notify-gw.test/digest/preview?date=2026-10-04", { headers: { "x-run-key": "test-run-key" } }),
      env,
    );
    const body = await res.text();
    // 未解消の一覧(先頭の「── 未解消 CRITICAL」から「実行:」の行まで)だけを見る。
    // その日の「失敗・CRITICAL」欄に同じ証跡が出るのは、その日に起きたことの一覧なので重複ではない
    const lines = body.split("\n");
    const head = lines.findIndex((l) => l.startsWith("── 未解消 CRITICAL"));
    const tail = lines.findIndex((l) => l.startsWith("実行:"));
    expect(head).toBeGreaterThanOrEqual(0);
    const section = lines.slice(head, tail).filter((l) => l.includes("fuwacchi-feed"));
    expect(section).toHaveLength(1);
    expect(section[0]).toContain("liveness-stale");
    expect(body).toContain("fuwacchi-feed: 申告途絶"); // 死活の欄(現状の一覧)はそのまま出す
  });
});
