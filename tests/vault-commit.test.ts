import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./helpers/env";
import { insertEvent } from "../src/lib/db";
import { toBase64Utf8 } from "../src/lib/github";
import { checkTokenExpiry } from "../src/lib/token_expiry";
import { renderVaultSummary } from "../src/lib/vault_digest";
import type { DigestData } from "../src/lib/digest";

const AUTH = { "x-run-key": "test-run-key" };

function runDigest(env: Parameters<typeof worker.fetch>[1]) {
  return worker.fetch(new Request("https://notify-gw.test/digest/run", { method: "POST", headers: AUTH }), env);
}

/** Discord と GitHub の両方を捌く fetch モック */
function mockFetch(githubStatus = { get: 404, put: 201 }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.github.com")) {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "PUT") {
        return new Response(JSON.stringify({ commit: { html_url: "https://github.com/x/y/commit/abc123" } }), {
          status: githubStatus.put,
        });
      }
      return new Response(githubStatus.get === 404 ? "Not Found" : JSON.stringify({ sha: "oldsha" }), {
        status: githubStatus.get,
      });
    }
    return new Response(null, { status: 204 }); // Discord
  });
}

describe("Vault への日次サマリコミット", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T01:00:00Z")); // JST 2026-09-14 10:00 → 前日 09-13
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function seedEvent(env: ReturnType<typeof makeEnv>) {
    // 失敗は Discord では上位N件に切り詰められるが、Vault には全件残る。
    // 日本語が base64 往復で壊れないことも同時に確認する。
    await insertEvent(env.NOTIFY_DB, {
      ts: "2026-09-13T04:00:00.000Z",
      agent_id: "tagtech-cron/hn-trends",
      action: "run",
      target: "日本語の要約テスト",
      result: "failure",
      severity: "CRITICAL",
      fingerprint: "fp-seed",
    });
  }

  it("PAT があれば GitHub へ upsert し、INFO 証跡と evidence_url を残す", async () => {
    const env = makeEnv({ GITHUB_TOKEN: "github_pat_dummy" });
    await seedEvent(env);
    global.fetch = mockFetch();

    expect((await runDigest(env)).status).toBe(200);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const put = calls.find(([u, i]) => String(u).includes("api.github.com") && (i as RequestInit)?.method === "PUT");
    expect(put).toBeDefined();
    expect(String(put![0])).toContain("/repos/tagtech-jp/tagtech-vault/contents/digest/notify-gw-2026-09-13.md");

    const sent = JSON.parse((put![1] as RequestInit).body as string) as { content: string; message: string; sha?: string };
    expect(sent.message).toContain("2026-09-13");
    expect(sent.sha).toBeUndefined(); // 新規(GET が 404)なので sha なし
    // 日本語が壊れずに往復する(btoa 直呼びでは壊れる)
    const decoded = Buffer.from(sent.content, "base64").toString("utf-8");
    expect(decoded).toContain("日本語の要約テスト");
    expect(decoded).toContain("生成LLM不使用");

    const row = await env.NOTIFY_DB.prepare(
      "SELECT result, severity, evidence_url FROM events WHERE action='vault-commit'",
    ).first<{ result: string; severity: string; evidence_url: string }>();
    expect(row).toMatchObject({ result: "success", severity: "INFO" });
    expect(row?.evidence_url).toContain("/commit/");
  });

  it("既存ファイルがあれば sha を付けて上書きする(冪等)", async () => {
    const env = makeEnv({ GITHUB_TOKEN: "github_pat_dummy" });
    await seedEvent(env);
    global.fetch = mockFetch({ get: 200, put: 200 });

    await runDigest(env);

    const put = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([u, i]) => String(u).includes("api.github.com") && (i as RequestInit)?.method === "PUT",
    );
    const sent = JSON.parse((put![1] as RequestInit).body as string) as { sha?: string };
    expect(sent.sha).toBe("oldsha");
  });

  it("PAT 未設定なら skip + WARN 証跡のみ(日報送信は止めない)", async () => {
    const env = makeEnv(); // GITHUB_TOKEN なし
    await seedEvent(env);
    global.fetch = mockFetch();

    expect((await runDigest(env)).status).toBe(200);

    const githubCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes("api.github.com"),
    );
    expect(githubCalls).toHaveLength(0);

    const row = await env.NOTIFY_DB.prepare(
      "SELECT result, severity, target FROM events WHERE action='vault-commit'",
    ).first<{ result: string; severity: string; target: string }>();
    expect(row).toMatchObject({ result: "skip", severity: "WARN" });
    expect(row?.target).toContain("token_not_configured");
  });

  it("PAT 失効(401)は CRITICAL 証跡として #alerts に出す", async () => {
    const env = makeEnv({ GITHUB_TOKEN: "github_pat_expired" });
    await seedEvent(env);
    global.fetch = mockFetch({ get: 401, put: 201 });

    await runDigest(env);

    const row = await env.NOTIFY_DB.prepare(
      "SELECT result, severity, target FROM events WHERE action='vault-commit'",
    ).first<{ result: string; severity: string; target: string }>();
    expect(row).toMatchObject({ result: "failure", severity: "CRITICAL" });
    expect(row?.target).toContain("auth_401");

    const alerts = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]) === "https://discord.test/alerts",
    );
    expect(alerts).toHaveLength(1);
  });
});

describe("toBase64Utf8", () => {
  it("日本語を含む文字列を壊さず base64 化する", () => {
    const s = "# TagTech 日報 2026-09-14 ✅";
    expect(Buffer.from(toBase64Utf8(s), "base64").toString("utf-8")).toBe(s);
  });

  it("btoa 直呼びは非ASCIIで例外になる(この関数が必要な理由)", () => {
    expect(() => btoa("日本語")).toThrow();
  });
});

describe("PAT の期限監視 (14日前から警告)", () => {
  const now = Date.parse("2026-09-14T00:00:00Z");
  const check = (expiresOn: string | undefined) =>
    checkTokenExpiry([{ name: "GITHUB_TOKEN", expiresOn }], now, 14);

  it("期限まで15日以上あるうちは出さない", () => {
    expect(check("2026-12-13")).toEqual([]);
    expect(check("2026-09-29")).toEqual([]);
  });

  it("14日を切ったら残り日数つきで出す", () => {
    const r = check("2026-09-28");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ daysLeft: 14, expired: false });
  });

  it("期限切れは expired=true になる", () => {
    const r = check("2026-09-10");
    expect(r[0]).toMatchObject({ expired: true });
    expect(r[0]!.daysLeft).toBeLessThan(0);
  });

  it("未設定なら何も出さない(誤検知しない)", () => {
    expect(check(undefined)).toEqual([]);
  });
});

describe("Vault サマリ Markdown", () => {
  const base: DigestData = {
    dateJst: "2026-09-13",
    total: 3,
    success: 1,
    failure: 1,
    skip: 1,
    critical: 1,
    failures: [{ id: 9, agent_id: "tagtech-cron", action: "run", summary: "A | B\nC", count: 2 }],
    warnings: [],
    portingPending: ["tagtech-cron/tiktok-1200"],
    byAgent: [{ agent_id: "tagtech-cron", total: 3, success: 1, failure: 1, skip: 1 }],
  };

  it("Discord の 2000 字制限と違い全件を残す + front matter を持つ", () => {
    const md = renderVaultSummary(base, "2026-09-14T00:05:00.000Z");
    expect(md.startsWith("---\ndate: 2026-09-13")).toBe(true);
    expect(md).toContain("| e-9 | tagtech-cron | run |");
    expect(md).toContain("tagtech-cron/tiktok-1200");
    // テーブルを壊す文字を素通ししない
    expect(md).toContain("A \\| B C");
  });
});
