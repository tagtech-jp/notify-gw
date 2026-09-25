import { describe, expect, it } from "vitest";
import { renderDigest, type DigestData } from "../src/lib/digest";

const base: DigestData = {
  dateJst: "2026-09-09",
  total: 19,
  success: 15,
  failure: 3,
  skip: 1,
  critical: 1,
  failures: [
    { id: 42, agent_id: "tagtech-cron", action: "job-failed", summary: "TypeError: x is undefined", count: 1 },
    { id: 40, agent_id: "vault-intel", action: "commit-failed", summary: "GitHub 409 conflict", count: 3 },
  ],
  warnings: [],
  portingPending: [],
  byAgent: [
    { agent_id: "tagtech-cron", total: 18, success: 15, failure: 2, skip: 1 },
    { agent_id: "vault-intel", total: 1, success: 0, failure: 1, skip: 0 },
  ],
};

describe("renderDigest", () => {
  it("embeds only DB-provided numbers/ids/agent_ids — no free text generation", () => {
    const body = renderDigest(base);
    expect(body).toContain("📊 TagTech 日報 | 2026-09-09 (JST)");
    expect(body).toContain("実行: 19 件 | ✅ 15 | ❌ 3 | ⏭ 1 | 🔴 CRITICAL 1");
    expect(body).toContain("tagtech-cron job-failed: TypeError: x is undefined (証跡ID: e-42)");
    expect(body).toContain("vault-intel commit-failed: GitHub 409 conflict (証跡ID: e-40 ×3回)");
    expect(body).toContain("tagtech-cron: 18件 (✅15/❌2/⏭1)");
    expect(body).toContain("生成LLM不使用");
  });

  it("matches a manually computed SQL-aggregate string exactly", () => {
    const expected = [
      "📊 TagTech 日報 | 2026-09-09 (JST)",
      "実行: 19 件 | ✅ 15 | ❌ 3 | ⏭ 1 | 🔴 CRITICAL 1",
      "── 失敗・CRITICAL ──",
      "tagtech-cron job-failed: TypeError: x is undefined (証跡ID: e-42)",
      "vault-intel commit-failed: GitHub 409 conflict (証跡ID: e-40 ×3回)",
      "── エージェント別 ──",
      "tagtech-cron: 18件 (✅15/❌2/⏭1)",
      "vault-intel: 1件 (✅0/❌1/⏭0)",
      "※本日報は証跡DBのSQL集計のみで生成。生成LLM不使用。",
    ].join("\n");
    expect(renderDigest(base)).toBe(expected);
  });

  it("reports '(失敗・CRITICALなし)' when there are no failures", () => {
    const data: DigestData = { ...base, failures: [], failure: 0, critical: 0 };
    expect(renderDigest(data)).toContain("(失敗・CRITICALなし)");
  });

  it("shows '#alerts送信失敗: N件' when alertsFailed > 0 (判断2)", () => {
    const data: DigestData = { ...base, alertsFailed: 2 };
    expect(renderDigest(data)).toContain("── #alerts送信失敗: 2件 ──");
  });

  it("hides the #alerts送信失敗 line when alertsFailed is 0 or unset", () => {
    expect(renderDigest({ ...base, alertsFailed: 0 })).not.toContain("#alerts送信失敗");
    expect(renderDigest(base)).not.toContain("#alerts送信失敗");
  });

  it("lists WARN items in their own section (期限接近など、通知0件でも日報に残す)", () => {
    const data: DigestData = {
      ...base,
      warnings: [
        {
          id: 50,
          agent_id: "tagtech-cron/funding-reminder",
          action: "deadline-approaching",
          summary: "小規模事業者持続化補助金 第20回 締切 期限 2026-09-30（残り 19 日）",
          count: 1,
        },
      ],
    };
    const body = renderDigest(data);
    expect(body).toContain("── 注意(WARN) ──");
    expect(body).toContain(
      "tagtech-cron/funding-reminder deadline-approaching: 小規模事業者持続化補助金 第20回 締切 期限 2026-09-30（残り 19 日） (証跡ID: e-50)",
    );
  });

  it("omits the WARN section entirely when there are no warnings", () => {
    expect(renderDigest(base)).not.toContain("注意(WARN)");
  });

  it("compresses porting-pending jobs into one line and shows detail only when the set changed", () => {
    const jobs = ["tagtech-cron/tiktok-0700", "tagtech-cron/tiktok-1200", "tagtech-cron/sns-metrics"];
    const unchanged = renderDigest({ ...base, portingPending: jobs, portingPendingPrev: jobs });
    expect(unchanged).toContain("未移植: 3 ジョブ");
    expect(unchanged).not.toContain("追加:");
    expect(unchanged).not.toContain("tiktok-0700");

    const changed = renderDigest({
      ...base,
      portingPending: jobs,
      portingPendingPrev: ["tagtech-cron/tiktok-0700", "tagtech-cron/cxo-worker"],
    });
    expect(changed).toContain("未移植: 3 ジョブ (前日 2 / 追加: tagtech-cron/tiktok-1200, tagtech-cron/sns-metrics / 解消: tagtech-cron/cxo-worker)");
  });

  it("omits the porting line when there are no porting-pending jobs today or yesterday", () => {
    expect(renderDigest({ ...base, portingPendingPrev: [] })).not.toContain("未移植");
  });

  it("header and per-agent counts satisfy total = success + failure + skip", () => {
    const body = renderDigest(base);
    const header = /実行: (\d+) 件 \| ✅ (\d+) \| ❌ (\d+) \| ⏭ (\d+)/.exec(body);
    expect(header).not.toBeNull();
    const [, total, s, f, k] = header!.map(Number);
    expect(total).toBe(s + f + k);
    for (const m of body.matchAll(/: (\d+)件 \(✅(\d+)\/❌(\d+)\/⏭(\d+)\)/g)) {
      const [, t, as, af, ak] = m.map(Number);
      expect(t).toBe(as + af + ak);
    }
  });

  it("stays within the Discord 2000-character limit and truncates with an omitted count", () => {
    const manyFailures = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      agent_id: "tagtech-cron",
      action: "job-failed",
      summary: "同一エラーメッセージがここに長々と続く".repeat(3),
      count: 1,
    }));
    const data: DigestData = { ...base, failures: manyFailures, failure: 200 };
    const body = renderDigest(data);
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(body).toMatch(/他\d+件/);
  });
});
