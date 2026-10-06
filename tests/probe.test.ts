import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { createFakeD1 } from "./helpers/fakeD1";
import { LIVENESS_CRON, silentCheckRow } from "../src/lib/liveness";
import { PROBE_ACTION, PROBE_USER_AGENT, parseExternalProbes, probeHealth } from "../src/lib/probe";
import type { Env } from "../src/types";

const HEALTH_URL = "https://oborozuki.test/api/health";
const ALERTS_URL = "https://discord.test/alerts";
const NOW = Date.parse("2026-10-07T01:00:00.000Z"); // JST 10:00

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTIFY_DB: createFakeD1(),
    RUN_KEY: "test-run-key",
    DISCORD_WEBHOOK_ALERTS: ALERTS_URL,
    DISCORD_WEBHOOK_DIGEST: "https://discord.test/digest",
    MENTION_USER_ID: "12345",
    TZ_OFFSET_HOURS: "9",
    FLOOD_WINDOW_MIN: "30",
    DIGEST_HOUR_JST: "9",
    VAULT_REPO: "tagtech-jp/tagtech-vault",
    VAULT_DIGEST_DIR: "digest",
    TOKEN_WARN_DAYS: "14",
    FAST_LIVENESS: "",
    EXTERNAL_PROBES: `oborozuki-uranai=${HEALTH_URL}`,
    ...overrides,
  };
}

function healthResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const OK_BODY = { ok: true, checks: { db: true, drawLimiter: true, checkoutLimiter: true } };
const DB_DOWN_BODY = { ok: false, checks: { db: false, drawLimiter: true, checkoutLimiter: true } };

describe("parseExternalProbes", () => {
  it("「agent_id=URL」をカンマ区切りで読み、https でない・壊れた項目は捨てる", () => {
    const m = parseExternalProbes(
      ` oborozuki-uranai = https://oborozuki.jp/api/health ,http-site=http://example.com/health,bad,=https://x.example/h,sp ace=https://y.example/h,broken=https://,`,
    );
    expect([...m.entries()]).toEqual([["oborozuki-uranai", "https://oborozuki.jp/api/health"]]);
    expect(parseExternalProbes(undefined).size).toBe(0);
    expect(parseExternalProbes("").size).toBe(0);
  });
});

describe("probeHealth", () => {
  const fast = { attempts: 3, intervalMs: 0, timeoutMs: 1000 };

  it("200 かつ ok:true なら正常。User-Agent を付け、転送は追わない", async () => {
    const fetchImpl = vi.fn(async () => healthResponse(200, OK_BODY));
    const result = await probeHealth(HEALTH_URL, fetchImpl as unknown as typeof fetch, fast);
    expect(result).toEqual({ ok: true, status: 200, detail: "ok", attempts: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HEALTH_URL);
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("user-agent")).toBe(PROBE_USER_AGENT);
  });

  it("一時的に失敗しても、3回のうちに正常に戻れば正常", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(healthResponse(503, DB_DOWN_BODY))
      .mockResolvedValueOnce(healthResponse(200, OK_BODY));
    const result = await probeHealth(HEALTH_URL, fetchImpl as unknown as typeof fetch, fast);
    expect(result).toEqual({ ok: true, status: 200, detail: "ok", attempts: 2 });
  });

  it("3回とも失敗したら異常。確認口が返したダメな項目を説明に添える", async () => {
    // 本物の fetch と同じく、毎回新しい応答を返す(応答の中身は1回しか読めない)
    const fetchImpl = vi.fn(async () => healthResponse(503, DB_DOWN_BODY));
    const result = await probeHealth(HEALTH_URL, fetchImpl as unknown as typeof fetch, fast);
    expect(result).toEqual({ ok: false, status: 503, detail: "HTTP 503・db=false", attempts: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("接続できない・JSON でない・ok が true でない・転送は、どれも異常（例外は投げない）", async () => {
    const thrown = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    expect(await probeHealth(HEALTH_URL, thrown as unknown as typeof fetch, fast)).toEqual({
      ok: false,
      status: null,
      detail: "接続できない(TypeError)",
      attempts: 3,
    });
    const html = vi.fn(async () => new Response("<html>maintenance</html>", { status: 200 }));
    expect((await probeHealth(HEALTH_URL, html as unknown as typeof fetch, fast)).detail).toBe("HTTP 200・JSON ではない応答");
    const notOk = vi.fn(async () => healthResponse(200, { ok: "yes" }));
    expect((await probeHealth(HEALTH_URL, notOk as unknown as typeof fetch, fast)).ok).toBe(false);
    const moved = vi.fn(async () => new Response(null, { status: 301, headers: { Location: "https://elsewhere.example/" } }));
    expect((await probeHealth(HEALTH_URL, moved as unknown as typeof fetch, fast)).detail).toBe("HTTP 301・JSON ではない応答");
  });
});

describe("外形監視(15分ごとの cron)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let health: () => Response;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    health = () => healthResponse(200, OK_BODY);
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === HEALTH_URL) return health();
      return new Response(null, { status: 204 }); // Discord
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 試す間隔(5秒)の待ちは偽の時計で進める
  async function runCron(env: Env, cron = LIVENESS_CRON): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
    await worker.scheduled({ cron, scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, env,
      ctx as unknown as ExecutionContext);
    const all = Promise.all(pending);
    await vi.advanceTimersByTimeAsync(60_000);
    await all;
  }

  const discordCalls = () => fetchMock.mock.calls.filter(([input]) => String(input) === ALERTS_URL);

  async function probeEvents(env: Env): Promise<Array<{ result: string; severity: string; target: string }>> {
    const res = await env.NOTIFY_DB.prepare(
      `SELECT result, severity, target FROM events WHERE agent_id = 'oborozuki-uranai' AND action = ? ORDER BY id`,
    )
      .bind(PROBE_ACTION)
      .all<{ result: string; severity: string; target: string }>();
    return res.results ?? [];
  }

  it("応答しなくなったら CRITICAL で #alerts に1回だけ知らせ、戻ったら解消を記録し、また止まったらまた知らせる", async () => {
    const env = makeEnv();
    health = () => healthResponse(503, DB_DOWN_BODY);

    await runCron(env);
    expect(discordCalls()).toHaveLength(1);
    let events = await probeEvents(env);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ result: "failure", severity: "CRITICAL" });
    expect(events[0].target).toContain(HEALTH_URL);
    expect(events[0].target).toContain("db=false");

    // 止まったまま → 重ねて知らせない(日報の未解消一覧には毎日出る)
    vi.setSystemTime(Date.now() + 15 * 60 * 1000);
    await runCron(env);
    expect(discordCalls()).toHaveLength(1);
    expect(await probeEvents(env)).toHaveLength(1);

    // 戻った → success を記録する(#alerts には送らない)
    health = () => healthResponse(200, OK_BODY);
    vi.setSystemTime(Date.now() + 15 * 60 * 1000);
    await runCron(env);
    expect(discordCalls()).toHaveLength(1);
    events = await probeEvents(env);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ result: "success", severity: "INFO" });

    // 戻ったあとは何も記録しない
    vi.setSystemTime(Date.now() + 15 * 60 * 1000);
    await runCron(env);
    expect(await probeEvents(env)).toHaveLength(2);

    // また止まった → 新しい障害として知らせる(洪水抑制の30分より後)
    health = () => healthResponse(503, DB_DOWN_BODY);
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await runCron(env);
    expect(discordCalls()).toHaveLength(2);
    expect(await probeEvents(env)).toHaveLength(3);
  });

  it("一時的な揺れ(1回目だけ失敗)では知らせない", async () => {
    const env = makeEnv();
    let calls = 0;
    health = () => (++calls === 1 ? healthResponse(503, DB_DOWN_BODY) : healthResponse(200, OK_BODY));
    await runCron(env);
    expect(discordCalls()).toHaveLength(0);
    expect(await probeEvents(env)).toHaveLength(0);
  });

  it("外形監視だけでも判定の証拠を1日1件残し、件数を書く。両方空なら何もしない", async () => {
    const env = makeEnv();
    await runCron(env);
    const row = await env.NOTIFY_DB.prepare(
      `SELECT target FROM events WHERE agent_id = 'notify-gw/liveness' AND action = 'liveness-check'`,
    ).first<{ target: string }>();
    expect(row?.target).toBe("対象 0件・途絶 0件・外形監視 1件・応答なし 0件");

    const off = makeEnv({ EXTERNAL_PROBES: "" });
    await runCron(off);
    expect((await off.NOTIFY_DB.prepare(`SELECT COUNT(*) AS n FROM events`).first<{ n: number }>())?.n).toBe(0);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === HEALTH_URL)).toHaveLength(1); // off では見に行かない
  });

  it("判定そのものの沈黙は、外形監視だけの設定でも日報に出す", async () => {
    const db = createFakeD1();
    const asOf = new Date(NOW).toISOString();
    expect(await silentCheckRow(db, "", NOW, asOf, 0)).toBeNull();
    expect((await silentCheckRow(db, "", NOW, asOf, 1))?.action).toBe("liveness-check-missing");
  });
});

describe("wrangler.jsonc の EXTERNAL_PROBES", () => {
  it("oborozuki.jp の確認口が、壊れずに読める形で書かれている", () => {
    const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf-8");
    const raw = text.match(/"EXTERNAL_PROBES":\s*"([^"]+)"/)?.[1];
    expect(parseExternalProbes(raw).get("oborozuki-uranai")).toBe("https://oborozuki.jp/api/health");
  });
});
