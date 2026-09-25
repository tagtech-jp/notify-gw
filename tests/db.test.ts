import { describe, expect, it } from "vitest";
import { createFakeD1 } from "./helpers/fakeD1";
import {
  insertEvent,
  countRecentCriticalByFingerprint,
  aggregateRange,
  getLastEventTs,
  markDiscordResult,
  listUnresolvedCriticals,
} from "../src/lib/db";
import { dayRangeUtc } from "../src/lib/jst";

describe("insertEvent + getLastEventTs", () => {
  it("persists an event (追記専用) and returns the auto-increment id", async () => {
    const db = createFakeD1();
    const id1 = await insertEvent(db, {
      ts: "2026-09-09T01:00:00.000Z",
      agent_id: "tagtech-cron",
      action: "job-ok",
      result: "success",
      severity: "INFO",
      fingerprint: "fp1",
    });
    const id2 = await insertEvent(db, {
      ts: "2026-09-09T02:00:00.000Z",
      agent_id: "tagtech-cron",
      action: "job-ok",
      result: "success",
      severity: "INFO",
      fingerprint: "fp1",
    });
    expect(id2).toBe(id1 + 1);
    expect(await getLastEventTs(db)).toBe("2026-09-09T02:00:00.000Z");
  });

  it("rejects invalid severity/result via the CHECK constraint", async () => {
    const db = createFakeD1();
    await expect(
      insertEvent(db, {
        ts: "2026-09-09T01:00:00.000Z",
        agent_id: "x",
        action: "y",
        // @ts-expect-error 意図的に不正値を渡してCHECK制約を検証する
        result: "bogus",
        severity: "INFO",
        fingerprint: "fp",
      }),
    ).rejects.toThrow();
  });
});

describe("countRecentCriticalByFingerprint (洪水抑制)", () => {
  it("counts only CRITICAL events within the window for the same fingerprint", async () => {
    const db = createFakeD1();
    await insertEvent(db, {
      ts: "2026-09-09T01:00:00.000Z",
      agent_id: "a",
      action: "fail",
      result: "failure",
      severity: "CRITICAL",
      fingerprint: "fp-flood",
    });
    // 別fingerprint(カウントされない)
    await insertEvent(db, {
      ts: "2026-09-09T01:05:00.000Z",
      agent_id: "a",
      action: "fail",
      result: "failure",
      severity: "CRITICAL",
      fingerprint: "fp-other",
    });
    // WARN(カウントされない)
    await insertEvent(db, {
      ts: "2026-09-09T01:06:00.000Z",
      agent_id: "a",
      action: "fail",
      result: "failure",
      severity: "WARN",
      fingerprint: "fp-flood",
    });

    const count = await countRecentCriticalByFingerprint(db, "fp-flood", "2026-09-09T00:00:00.000Z");
    expect(count).toBe(1);
  });

  it("returns 0 when the matching event is outside the time window", async () => {
    const db = createFakeD1();
    await insertEvent(db, {
      ts: "2026-09-09T00:00:00.000Z",
      agent_id: "a",
      action: "fail",
      result: "failure",
      severity: "CRITICAL",
      fingerprint: "fp-flood",
    });
    const count = await countRecentCriticalByFingerprint(db, "fp-flood", "2026-09-09T01:00:00.000Z");
    expect(count).toBe(0);
  });
});

describe("aggregateRange", () => {
  it("computes totals/success/failure/critical purely from stored rows", async () => {
    const db = createFakeD1();
    const rows: Array<[string, "success" | "failure", "CRITICAL" | "WARN" | "INFO"]> = [
      ["tagtech-cron", "success", "INFO"],
      ["tagtech-cron", "success", "INFO"],
      ["tagtech-cron", "failure", "CRITICAL"],
      ["vault-intel", "failure", "WARN"],
    ];
    for (const [agent, result, severity] of rows) {
      await insertEvent(db, {
        ts: "2026-09-09T03:00:00.000Z",
        agent_id: agent,
        action: "job",
        target: `${agent}-error`,
        result,
        severity,
        fingerprint: `${agent}-${result}`,
      });
    }

    const { startUtc, endUtc } = dayRangeUtc("2026-09-09", 9);
    const agg = await aggregateRange(db, startUtc, endUtc);
    expect(agg.total).toBe(4);
    expect(agg.success).toBe(2);
    expect(agg.failure).toBe(2);
    expect(agg.critical).toBe(1);
    expect(agg.skip).toBe(0);
    expect(agg.byAgent).toEqual(
      expect.arrayContaining([
        { agent_id: "tagtech-cron", total: 3, success: 2, failure: 1, skip: 0 },
        { agent_id: "vault-intel", total: 1, success: 0, failure: 1, skip: 0 },
      ]),
    );
  });

  it("counts alertsFailed as CRITICAL events with discord_sent=0 (判断2)", async () => {
    const db = createFakeD1();
    const idOk = await insertEvent(db, {
      ts: "2026-09-09T03:00:00.000Z",
      agent_id: "a",
      action: "job",
      result: "failure",
      severity: "CRITICAL",
      fingerprint: "fp-ok",
    });
    const idFail = await insertEvent(db, {
      ts: "2026-09-09T03:01:00.000Z",
      agent_id: "b",
      action: "job",
      result: "failure",
      severity: "CRITICAL",
      fingerprint: "fp-fail",
    });
    await markDiscordResult(db, idOk, true, 204);
    await markDiscordResult(db, idFail, false, 400);

    const { startUtc, endUtc } = dayRangeUtc("2026-09-09", 9);
    const agg = await aggregateRange(db, startUtc, endUtc);
    expect(agg.critical).toBe(2);
    expect(agg.alertsFailed).toBe(1);
  });

  it("markDiscordResult は列が無くても(不正なテーブルでも) throw しない", async () => {
    const db = createFakeD1();
    // 存在しない id への UPDATE は 0 行更新で成功する。例外系の代表として、
    // そもそも呼び出しが reject しないことだけを確認する(本体の書き込みを止めないのが目的)。
    await expect(markDiscordResult(db, 999999, true, 204)).resolves.toBeUndefined();
  });

  it("groups failures by fingerprint and counts repeats (証跡ID ×N回)", async () => {
    const db = createFakeD1();
    for (let i = 0; i < 3; i++) {
      await insertEvent(db, {
        ts: "2026-09-09T04:00:00.000Z",
        agent_id: "tagtech-cron",
        action: "job-failed",
        target: "TypeError: x is undefined",
        result: "failure",
        severity: "CRITICAL",
        fingerprint: "same-error",
      });
    }
    const { startUtc, endUtc } = dayRangeUtc("2026-09-09", 9);
    const agg = await aggregateRange(db, startUtc, endUtc);
    expect(agg.failures).toHaveLength(1);
    expect(agg.failures[0].count).toBe(3);
    expect(agg.failures[0].summary).toBe("TypeError: x is undefined");
  });

  it("separates WARN notices and porting-pending jobs from failures and per-agent rows", async () => {
    const db = createFakeD1();
    const ts = "2026-09-09T04:00:00.000Z";
    // 期限接近(WARN, 失敗ではない) → warnings に載る
    await insertEvent(db, {
      ts,
      agent_id: "tagtech-cron/funding-reminder",
      action: "deadline-approaching",
      target: "持続化補助金 期限 2026-09-30（残り 19 日）",
      result: "success",
      severity: "WARN",
      fingerprint: "fp-deadline",
    });
    // 未移植(WARN/skip) ×2ジョブ → portingPending に畳まれ、warnings/byAgent からは除外
    for (const job of ["tiktok-0700", "sns-metrics"]) {
      await insertEvent(db, {
        ts,
        agent_id: `tagtech-cron/${job}`,
        action: "porting-pending",
        target: "scripts/legacy.py",
        result: "skip",
        severity: "WARN",
        fingerprint: `fp-porting-${job}`,
      });
    }
    // WARN でも result=failure なら failures 側(二重掲載しない)
    await insertEvent(db, {
      ts,
      agent_id: "notify-gw/selftest",
      action: "utf8-verify",
      target: "x",
      result: "failure",
      severity: "WARN",
      fingerprint: "fp-warn-failure",
    });

    const { startUtc, endUtc } = dayRangeUtc("2026-09-09", 9);
    const agg = await aggregateRange(db, startUtc, endUtc);

    expect(agg.warnings.map((w) => w.action)).toEqual(["deadline-approaching"]);
    expect(agg.failures.map((f) => f.action)).toEqual(["utf8-verify"]);
    expect(agg.portingPending).toEqual(["tagtech-cron/sns-metrics", "tagtech-cron/tiktok-0700"]);
    expect(agg.byAgent.map((a) => a.agent_id)).not.toContain("tagtech-cron/tiktok-0700");
    expect(agg.total).toBe(4); // 実行件数には未移植の skip も含む(事実として走った回数)
    expect(agg.skip).toBe(2);
    expect(agg.total).toBe(agg.success + agg.failure + agg.skip);
  });

  it("excludes events outside the [startUtc, endUtc) range", async () => {
    const db = createFakeD1();
    await insertEvent(db, {
      ts: "2026-09-08T10:00:00.000Z", // 前日
      agent_id: "a",
      action: "job",
      result: "success",
      severity: "INFO",
      fingerprint: "fp",
    });
    const { startUtc, endUtc } = dayRangeUtc("2026-09-09", 9);
    const agg = await aggregateRange(db, startUtc, endUtc);
    expect(agg.total).toBe(0);
  });
});

describe("listUnresolvedCriticals: alert_failed の集計(判断2)", () => {
  it("グループ内の discord_sent=0 の件数を alert_failed として返す", async () => {
    const db = createFakeD1();
    const id1 = await insertEvent(db, {
      ts: "2026-09-09T03:00:00.000Z",
      agent_id: "tagtech-cron",
      action: "job-failed",
      result: "failure",
      severity: "CRITICAL",
      fingerprint: "fp-1",
    });
    const id2 = await insertEvent(db, {
      ts: "2026-09-09T04:00:00.000Z",
      agent_id: "tagtech-cron",
      action: "job-failed",
      result: "failure",
      severity: "CRITICAL",
      fingerprint: "fp-2",
    });
    await markDiscordResult(db, id1, true, 204);
    await markDiscordResult(db, id2, false, 400);

    const rows = await listUnresolvedCriticals(db, "2026-09-09T05:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].alert_failed).toBe(1);
  });
});
