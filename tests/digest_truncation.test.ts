/**
 * 日報の 2000 字切り詰めの優先順位。
 *
 * 【2026-09-18 に発覚したバグ】
 * 09-15 分の日報が "── 失敗・CRITICAL ──\n他2件" となり、**項目が1行も出ていなかった**。
 * 原因は renderDigest の圧縮ループが failureKeep を 0 まで削ること。
 * 一方「エージェント別」は1件も圧縮されず、本来の容量喰いはそちらだった。
 *
 * 異常を伝えるための日報で、異常だけが消えて正常なエージェント一覧が残っていた。
 *
 * 【あるべき優先順位】
 * 削ってよい順に:  エージェント別 → 実体判定の内訳 → WARN → 失敗・CRITICAL
 * **失敗・CRITICAL と死活異常は最後まで残す。** 全文は Vault にある。
 */
import { describe, expect, it } from "vitest";
import { renderDigest, type DigestData } from "../src/lib/digest";
import type { AgentRow, FailureRow, UnsubstantiatedRow } from "../src/lib/db";

const failure = (i: number): FailureRow => ({
  id: 300 + i,
  agent_id: `github-actions/tagtech-automation-${i}`,
  action: "deploy",
  summary: `本番デプロイが失敗しました（詳細な説明を含む長めの要約テキスト ${i}）`,
  count: 1,
});

const warn = (i: number): FailureRow => ({
  id: 400 + i,
  agent_id: `tagtech-cron/job-${i}`,
  action: "deadline-approaching",
  summary: `期限が近づいています（長めの説明テキスト ${i}）`,
  count: 1,
});

/** エージェント別は件数が多いと容量を食う。ここを先に削る */
const agent = (i: number): AgentRow => ({
  agent_id: `tagtech-automation/very-long-agent-identifier-number-${i}`,
  total: 10,
  success: 9,
  failure: 0,
  skip: 1,
});

const base = (over: Partial<DigestData> = {}): DigestData => ({
  dateJst: "2026-09-15",
  total: 88,
  success: 74,
  failure: 2,
  skip: 12,
  critical: 1,
  failures: [],
  warnings: [],
  portingPending: [],
  unsubstantiated: [],
  byAgent: [],
  ...over,
});

describe("renderDigest: 2000字に収めるときの優先順位", () => {
  it("2000字以内に収まる", () => {
    const body = renderDigest(
      base({
        failures: Array.from({ length: 20 }, (_, i) => failure(i)),
        warnings: Array.from({ length: 20 }, (_, i) => warn(i)),
        byAgent: Array.from({ length: 60 }, (_, i) => agent(i)),
      }),
    );
    expect(body.length).toBeLessThanOrEqual(2000);
  });

  /**
   * これが本体のバグ。CRITICAL が1件でもあれば、その項目が必ず本文に出ること。
   * 「他N件」だけの表示は、異常を伝える日報として機能していない。
   */
  it("CRITICAL が1件以上あれば、必ずその項目が本文に出る", () => {
    const body = renderDigest(
      base({
        failures: Array.from({ length: 20 }, (_, i) => failure(i)),
        warnings: Array.from({ length: 20 }, (_, i) => warn(i)),
        byAgent: Array.from({ length: 60 }, (_, i) => agent(i)),
      }),
    );
    // 少なくとも1件の証跡IDが本文にある
    expect(body).toMatch(/証跡ID: e-\d+/);
    // 「他N件」だけになっていない
    const section = body.slice(body.indexOf("── 失敗・CRITICAL ──"));
    expect(section).not.toMatch(/^── 失敗・CRITICAL ──\n他\d+件/);
  });

  it("実データ相当（09-15 分）で失敗2件が両方とも出る", () => {
    const body = renderDigest(
      base({
        failures: [
          {
            id: 258,
            agent_id: "growth-collector",
            action: "weekly-manual-pending",
            summary: "週次手入力 7件未入力 (2026-09-14週): note/articles_7d, note/followers, note/likes_7d",
            count: 1,
          },
          {
            id: 300,
            agent_id: "github-actions/tagtech-automation",
            action: "deploy",
            summary: "e217444ffcb59d2b1d9436e8e10effd2da6e5669",
            count: 1,
          },
        ],
        warnings: Array.from({ length: 10 }, (_, i) => warn(i)),
        byAgent: Array.from({ length: 40 }, (_, i) => agent(i)),
      }),
    );
    expect(body).toContain("e-258");
    expect(body).toContain("e-300");
  });

  it("エージェント別が先に畳まれる（容量を食っているのはそちら）", () => {
    const body = renderDigest(
      base({
        failures: [failure(0)],
        byAgent: Array.from({ length: 60 }, (_, i) => agent(i)),
      }),
    );
    expect(body).toContain("e-300");
    // エージェント別は畳まれて「他M件」になる
    expect(body.slice(body.indexOf("── エージェント別 ──"))).toMatch(/他\d+件/);
  });

  it("死活異常（バインディング申告途絶）は切られない", () => {
    const body = renderDigest(
      base({
        failures: Array.from({ length: 10 }, (_, i) => failure(i)),
        byAgent: Array.from({ length: 60 }, (_, i) => agent(i)),
        bindingDrifts: [
          {
            agent_id: "tagtech-cron",
            missing: [],
            reported_at: "2026-09-15T00:05:00.000Z",
            stale: true,
            neverReported: false,
          },
        ],
      }),
    );
    expect(body).toContain("tagtech-cron");
    expect(body).toContain("── 死活");
  });

  it("未解消 CRITICAL の持ち越しも切られない（先頭に出る）", () => {
    const body = renderDigest(
      base({
        failures: Array.from({ length: 10 }, (_, i) => failure(i)),
        byAgent: Array.from({ length: 60 }, (_, i) => agent(i)),
        unresolvedCriticals: [
          {
            agent_id: "github-actions/tagtech-automation",
            action: "deploy",
            summary: "本番デプロイが失敗",
            first_id: 300,
            first_ts: "2026-09-15T08:22:00.000Z",
            count: 3,
          },
        ],
        nowMs: Date.parse("2026-09-18T00:05:00.000Z"),
      }),
    );
    expect(body).toContain("未解消 CRITICAL");
    expect(body.indexOf("未解消 CRITICAL")).toBeLessThan(body.indexOf("実行:"));
  });

  it("圧縮が不要なら何も畳まない", () => {
    const body = renderDigest(base({ failures: [failure(0)], byAgent: [agent(0)] }));
    expect(body).not.toMatch(/他\d+件/);
  });
});

describe("実体判定の件数はイベント数ではなくタスク数で数える", () => {
  /**
   * 同じタスクが1日に何度も落ちると、イベント数は膨らむがタスク数は変わらない。
   * 「設計上の誤り 46件」と出ていたのは 23 タスク × 2 回のイベント数だった。
   * 直すべき対象の数はタスク数なので、そちらを出す。
   */
  const unsub = (agent: string, count: number): UnsubstantiatedRow => ({
    agent_id: agent,
    action: "run",
    reason: "deterministic_via_llm",
    count,
  });

  it("イベント数の合計ではなく、行数（タスク数）を出す", () => {
    const body = renderDigest(
      base({
        unsubstantiated: [unsub("a", 2), unsub("b", 2), unsub("c", 2)],
      }),
    );
    // 3タスク（イベント数の合計は 6）
    expect(body).toContain("設計上の誤り: 3 件");
    expect(body).not.toContain("設計上の誤り: 6 件");
  });

  it("前日比もタスク数で比較する", () => {
    const body = renderDigest(
      base({
        unsubstantiated: [unsub("a", 5), unsub("b", 5)],
        unsubstantiatedPrev: [unsub("a", 1), unsub("b", 1), unsub("c", 1)],
      }),
    );
    // 3タスク → 2タスク（-1）。イベント数なら 3 → 10 で増加に見えてしまう
    expect(body).toContain("前日 3 → 2 (-1)");
  });

  it("成功の内数表示もタスク数で数える", () => {
    const body = renderDigest(
      base({ success: 66, unsubstantiated: [unsub("a", 4), unsub("b", 4)] }),
    );
    expect(body).toContain("うち実体なし 2");
  });
});
