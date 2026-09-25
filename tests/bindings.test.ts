import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createFakeD1 } from "./helpers/fakeD1";
import { auditBindings, upsertBindingReport, getExpectedBindings } from "../src/lib/db";
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

const AUTH = { "x-run-key": "test-run-key", "content-type": "application/json" };

function report(body: unknown): Request {
  return new Request("https://notify-gw.test/bindings/report", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify(body),
  });
}

const CRON_EXPECTED = ["NOTIFY_GW", "NOTIFY_GW_KEY", "WATCHDOG_STATE", "DISCORD_WEBHOOK_URL", "DISCORD_WEBHOOK_ALERTS"];

describe("expected_bindings (期待値は D1 が唯一の真実源)", () => {
  it("registers vault-sync as a liveness-only agent (バインディング無し・ハートビート途絶のみ監視)", async () => {
    const db = createFakeD1();
    expect(await getExpectedBindings(db, "vault-sync")).toEqual([]);
  });

  it("seeds the four workers from the migration", async () => {
    const db = createFakeD1();
    expect(await getExpectedBindings(db, "tagtech-cron")).toEqual(CRON_EXPECTED);
    expect(await getExpectedBindings(db, "notify-gw")).toContain("NOTIFY_DB");
    expect(await getExpectedBindings(db, "tagtech-automation")).toContain("NOTIFY_GW");
    expect(await getExpectedBindings(db, "vault-intel")).toContain("GITHUB_TOKEN");
    expect(await getExpectedBindings(db, "unknown-worker")).toBeNull();
  });
});

describe("POST /bindings/report", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires auth and rejects unknown agents", async () => {
    const env = makeEnv();
    const noAuth = await worker.fetch(
      new Request("https://notify-gw.test/bindings/report", { method: "POST", body: "{}" }),
      env,
    );
    expect(noAuth.status).toBe(403);

    const unknown = await worker.fetch(report({ agent_id: "nope", bindings: [] }), env);
    expect(unknown.status).toBe(404);
  });

  it("accepts a complete report without alerting", async () => {
    const env = makeEnv();
    const res = await worker.fetch(report({ agent_id: "tagtech-cron", bindings: CRON_EXPECTED }), env);
    const data = (await res.json()) as { missing: string[] };
    expect(res.status).toBe(200);
    expect(data.missing).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();

    expect(await auditBindings(env.NOTIFY_DB, Date.now())).toEqual(
      // 申告した tagtech-cron 以外の3件は「申告なし」で残る
      expect.not.arrayContaining([expect.objectContaining({ agent_id: "tagtech-cron" })]),
    );
  });

  it("records CRITICAL and alerts #alerts when an expected binding is missing", async () => {
    const env = makeEnv();
    const withoutGw = CRON_EXPECTED.filter((b) => b !== "NOTIFY_GW");
    const res = await worker.fetch(report({ agent_id: "tagtech-cron", bindings: withoutGw }), env);
    const data = (await res.json()) as { missing: string[] };
    expect(data.missing).toEqual(["NOTIFY_GW"]);

    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://discord.test/alerts");
    expect(String(init.body)).toContain("NOTIFY_GW");

    const row = await env.NOTIFY_DB.prepare(
      "SELECT agent_id, action, severity, result FROM events WHERE action = 'binding-drift'",
    ).first<{ agent_id: string; severity: string; result: string }>();
    expect(row).toMatchObject({ agent_id: "tagtech-cron", severity: "CRITICAL", result: "failure" });
  });

  it("keeps only the latest report per agent (cron/起動ごとの上書き)", async () => {
    const env = makeEnv();
    await worker.fetch(report({ agent_id: "vault-intel", bindings: [] }), env);
    await worker.fetch(
      report({ agent_id: "vault-intel", bindings: ["NOTIFY_GW", "NOTIFY_GW_KEY", "GITHUB_TOKEN"], version_hint: "v2" }),
      env,
    );
    const rows = await env.NOTIFY_DB.prepare("SELECT COUNT(*) c FROM binding_reports WHERE agent_id='vault-intel'")
      .first<{ c: number }>();
    expect(rows?.c).toBe(1);

    const drifts = await auditBindings(env.NOTIFY_DB, Date.now());
    expect(drifts.find((d) => d.agent_id === "vault-intel")).toBeUndefined();
  });
});

describe("auditBindings (24時間申告なし = stale)", () => {
  it("flags an agent whose last report is older than 26h", async () => {
    const db = createFakeD1();
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    await upsertBindingReport(db, {
      agentId: "tagtech-cron",
      bindings: CRON_EXPECTED,
      missing: [],
      reportedAt: new Date(now - 27 * 3600 * 1000).toISOString(),
    });
    const drift = (await auditBindings(db, now)).find((d) => d.agent_id === "tagtech-cron");
    expect(drift).toMatchObject({ stale: true, missing: [] });
  });

  it("does not flag a report from 25h ago (日次cronが1回ずれても誤検知しない)", async () => {
    const db = createFakeD1();
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    await upsertBindingReport(db, {
      agentId: "tagtech-cron",
      bindings: CRON_EXPECTED,
      missing: [],
      reportedAt: new Date(now - 25 * 3600 * 1000).toISOString(),
    });
    expect((await auditBindings(db, now)).find((d) => d.agent_id === "tagtech-cron")).toBeUndefined();
  });

  it("flags every seeded agent that has never reported", async () => {
    const db = createFakeD1();
    const drifts = await auditBindings(db, Date.now());
    expect(drifts.map((d) => d.agent_id).sort()).toEqual([
      "notify-gw",
      "tagtech-automation",
      "tagtech-cron",
      "vault-intel",
      "vault-sync",
    ]);
    expect(drifts.every((d) => d.stale && d.reported_at === null)).toBe(true);
  });
});

describe("GET /bindings/audit", () => {
  it("returns ok:false with the drift list", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://notify-gw.test/bindings/audit", { headers: { "x-run-key": "test-run-key" } }),
      env,
    );
    const data = (await res.json()) as { ok: boolean; drifts: Array<{ agent_id: string }> };
    expect(data.ok).toBe(false);
    expect(data.drifts).toHaveLength(5);
  });
});
