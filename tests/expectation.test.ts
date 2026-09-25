import { describe, expect as vitestExpect, it, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import { makeEnv } from "./helpers/env";
import { evaluateExpectation, isExpectation, reasonLabel } from "../src/lib/expectation";
import { aggregateRange } from "../src/lib/db";
import { renderDigest } from "../src/lib/digest";
import { renderVaultSummary } from "../src/lib/vault_digest";

const AUTH = { "x-run-key": "test-run-key", "content-type": "application/json" };

// 2026-09-13 に実際に tagtech-automation/hn_trends_morning が返してきた出力(先頭部分)。
// 「HN のトレンド取得」を指示したのに、LLM は作り方の解説を返していた。
const REAL_TUTORIAL_OUTPUT = `## 📌 目的
- **Hacker News のトレンド（フロントページ）を定期取得**
- 取得した記事を **Discord のチャンネルへ自動通知**

以下では、**Python 3** だけで完結できるシンプルな実装例と、実運用に向けたポイントをまとめます。`;

// 同じ日に tagtech-cron/hn-trends が実際に取得した本物のデータ
const REAL_HN_DATA = `1. [JetKVM Mini](https://jetkvm.com/blog/introducing-jetkvm-mini)
   487pt / 188コメント
2. [Why is Google still serving dodgy ads?](https://www.atomic14.com/2026/09/13/why-is-google)
   312pt / 145コメント`;

describe("実体判定 evaluateExpectation", () => {
  it("解説文は「実体なし」と判定する(実際の捏造事例の再現)", () => {
    const v = evaluateExpectation("external_data", REAL_TUTORIAL_OUTPUT);
    vitestExpect(v.ok).toBe(false);
    vitestExpect(v.reason).toBe("no_verifiable_facts");
    vitestExpect(v.facts?.urls).toBe(0);
  });

  it("実データは通す(誤検知しない)", () => {
    const v = evaluateExpectation("external_data", REAL_HN_DATA);
    vitestExpect(v.ok).toBe(true);
    vitestExpect(v.facts!.urls).toBeGreaterThanOrEqual(1);
  });

  it("URL が無くても独立した数値が3つ以上あれば実体とみなす", () => {
    vitestExpect(evaluateExpectation("external_data", "売上 12345 円 / 前月比 87 % / 件数 42").ok).toBe(true);
    vitestExpect(evaluateExpectation("external_data", "売上は好調でした").ok).toBe(false);
  });

  it("deterministic は内容を見るまでもなく設計上の誤りとして落とす", () => {
    const v = evaluateExpectation("deterministic", REAL_HN_DATA);
    vitestExpect(v.ok).toBe(false);
    vitestExpect(v.reason).toBe("deterministic_via_llm");
  });

  it("none と空出力", () => {
    vitestExpect(evaluateExpectation("none", "").ok).toBe(true);
    vitestExpect(evaluateExpectation("external_data", "").reason).toBe("empty_output");
    vitestExpect(evaluateExpectation("external_data", null).reason).toBe("empty_output");
  });

  it("LLM を呼ぶ経路が無い(決定論的判定であることの固定)", () => {
    // このモジュールは fetch を一切使わない。使い始めたらこのテストが落ちる。
    const spy = vi.fn();
    const original = global.fetch;
    global.fetch = spy as never;
    evaluateExpectation("external_data", REAL_TUTORIAL_OUTPUT);
    evaluateExpectation("deterministic", "x");
    vitestExpect(spy).not.toHaveBeenCalled();
    global.fetch = original;
  });

  it("isExpectation / reasonLabel", () => {
    vitestExpect(isExpectation("external_data")).toBe(true);
    vitestExpect(isExpectation("whatever")).toBe(false);
    vitestExpect(reasonLabel("deterministic_via_llm")).toContain("設計上の誤り");
    vitestExpect(reasonLabel(undefined)).toBe("");
  });
});

describe("POST /event の expect 受け付け", () => {
  const post = (env: ReturnType<typeof makeEnv>, body: unknown) =>
    worker.fetch(new Request("https://notify-gw.test/event", { method: "POST", headers: AUTH, body: JSON.stringify(body) }), env);

  it("expect 未指定なら従来どおり素通しする(後方互換)", async () => {
    const env = makeEnv();
    const res = await post(env, { agent_id: "a/b", action: "run", result: "success", severity: "INFO" });
    vitestExpect(res.status).toBe(200);
    const row = await env.NOTIFY_DB.prepare("SELECT meta FROM events WHERE id = 1").first<{ meta: string | null }>();
    vitestExpect(row?.meta ?? "").not.toContain("expectation");
  });

  it("不正な expect は 400 で弾く", async () => {
    const env = makeEnv();
    const res = await post(env, { agent_id: "a/b", action: "run", severity: "INFO", expect: "magic" });
    vitestExpect(res.status).toBe(400);
  });

  it("実体なしでも result は申告のまま残す(events は追記専用・申告を書き換えない)", async () => {
    const env = makeEnv();
    await post(env, {
      agent_id: "tagtech-automation/hn_trends_morning",
      action: "run",
      result: "success",
      severity: "INFO",
      expect: "external_data",
      meta: { text_preview: REAL_TUTORIAL_OUTPUT },
    });
    const row = await env.NOTIFY_DB.prepare("SELECT result, meta FROM events WHERE id = 1").first<{
      result: string;
      meta: string;
    }>();
    vitestExpect(row!.result).toBe("success");
    const meta = JSON.parse(row!.meta) as { expectation: { ok: boolean; reason: string } };
    vitestExpect(meta.expectation.ok).toBe(false);
    vitestExpect(meta.expectation.reason).toBe("no_verifiable_facts");
  });
});

describe("日報での「実体なし」の扱い", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T01:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("✅ の内数として分離し、専用セクションに一覧を出す", async () => {
    const env = makeEnv();
    const post = (body: unknown) =>
      worker.fetch(new Request("https://notify-gw.test/event", { method: "POST", headers: AUTH, body: JSON.stringify(body) }), env);

    await post({
      agent_id: "tagtech-automation/hn_trends_morning",
      action: "run",
      result: "success",
      severity: "INFO",
      expect: "external_data",
      meta: { text_preview: REAL_TUTORIAL_OUTPUT },
    });
    await post({
      agent_id: "tagtech-automation/funding_reminder",
      action: "run",
      result: "success",
      severity: "INFO",
      expect: "deterministic",
      meta: { text_preview: "期限を確認する方法" },
    });
    await post({
      agent_id: "tagtech-cron/hn-trends",
      action: "run",
      result: "success",
      severity: "INFO",
      expect: "external_data",
      meta: { text_preview: REAL_HN_DATA },
    });

    const agg = await aggregateRange(env.NOTIFY_DB, "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    vitestExpect(agg.success).toBe(3);
    vitestExpect(agg.unsubstantiated).toHaveLength(2);

    const body = renderDigest({ ...agg, dateJst: "2026-09-13" });
    vitestExpect(body).toContain("✅ 3(うち実体なし 2)");
    // 日報は件数の1行に畳む。21行並べると1通に圧縮した意味が失われる
    vitestExpect(body).toContain("設計上の誤り: 1 件 (詳細は Vault の日次サマリ)");
    vitestExpect(body).toContain("実体なし: 1 件 (詳細は Vault の日次サマリ)");
    // 理由の明細は日報に出さない(件数だけ)。agent_id 自体は「エージェント別」に出るのでそこは見ない
    vitestExpect(body).not.toContain("解説文の疑い");
    vitestExpect(body).not.toContain("決定論的処理を LLM に委譲");

    // Vault 側には全件を残す
    const md = renderVaultSummary({ ...agg, dateJst: "2026-09-13" }, "2026-09-14T00:05:00.000Z");
    vitestExpect(md).toContain("## 実体の伴わない成功");
    // 当該セクションだけを切り出して中身を見る(他セクションにも agent_id は出るため)
    const section = md.slice(md.indexOf("## 実体の伴わない成功"));
    const table = section.slice(0, section.indexOf("## 失敗"));
    vitestExpect(table).toContain("tagtech-automation/hn_trends_morning");
    vitestExpect(table).toContain("tagtech-automation/funding_reminder");
    vitestExpect(table).toContain("設計上の誤り 1 件 / 実体なし 1 件");
    // 実データを返した側は載せない(誤検知しない)
    vitestExpect(table).not.toContain("tagtech-cron/hn-trends");
  });

  /**
   * 2026-09-18: 件数の意味を**イベント数からタスク数へ変更**した。
   * 同じタスクが1日に何度も落ちるとイベント数は膨らむが、直すべき対象の数は変わらない。
   * 実際 09-16 の日報に「設計上の誤り 46件」と出ていたが、対象タスクは 23 件だった。
   *
   * ここでは prev が 2 タスク(count 3 と 2)、cur が 1 タスク(count 1)なので
   * 2 → 1 (-1) になる。イベント数なら 5 → 1 (-4) だった。
   */
  it("前日比を出す。減少は進捗なので解消したジョブ名まで見せる（件数はタスク数）", () => {
    const base = {
      dateJst: "2026-09-14",
      total: 0, success: 0, failure: 0, skip: 0, critical: 0,
      failures: [], warnings: [], portingPending: [], byAgent: [],
    };
    const prev = [
      { agent_id: "a/x", action: "run", reason: "no_verifiable_facts", count: 3 },
      { agent_id: "a/y", action: "run", reason: "no_verifiable_facts", count: 2 },
    ];
    const cur = [{ agent_id: "a/x", action: "run", reason: "no_verifiable_facts", count: 1 }];

    const down = renderDigest({ ...base, unsubstantiated: cur, unsubstantiatedPrev: prev });
    vitestExpect(down).toContain("実体なし: 1 件 (前日 2 → 1 (-1) / 解消: a/y)");

    const up = renderDigest({ ...base, unsubstantiated: prev, unsubstantiatedPrev: cur });
    vitestExpect(up).toContain("(前日 1 → 2 (+1))");

    // 増減なしなら差分を出さない(ノイズを増やさない)
    const same = renderDigest({ ...base, unsubstantiated: cur, unsubstantiatedPrev: cur });
    vitestExpect(same).toContain("実体なし: 1 件 (詳細は Vault の日次サマリ)");
  });

  it("実体なしがゼロなら表記も増えない(既存日報を汚さない)", async () => {
    const env = makeEnv();
    const agg = await aggregateRange(env.NOTIFY_DB, "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    const body = renderDigest({ ...agg, dateJst: "2026-09-13" });
    vitestExpect(body).toContain("✅ 0 |");
    vitestExpect(body).not.toContain("実体なし");
  });
});
