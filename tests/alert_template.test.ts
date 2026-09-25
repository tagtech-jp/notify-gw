/**
 * #alerts の CRITICAL 本文を「行動可能」にする。
 *
 * 【2026-09-18 の指摘】
 * 現状の本文は
 *   `github-actions/tagtech-automation deploy: e217444ffcb59d2b1d9436e8e10effd2da6e5669`
 * のみで、**何が失敗し何をすべきか分からない**。SHA だけ見せられても動けない。
 *
 * 最低限これを含める:
 *   1. 何が起きたか（1行の日本語）
 *   2. どこを見るか（evidence_url）
 *   3. 次にすべきこと
 *
 * テンプレートは error_kind で引く。未知の error_kind でも必ず何か返す
 * （「テンプレートが無いので出さない」は最悪の挙動）。
 */
import { describe, expect, it } from "vitest";
import { buildCriticalPayload } from "../src/lib/discord";

const base = {
  agentId: "github-actions/tagtech-automation",
  action: "deploy",
  target: "e217444ffcb59d2b1d9436e8e10effd2da6e5669",
  errorKind: "deploy_failure",
  eventId: 300,
  evidenceUrl: "https://github.com/nikkun22/tagtech-automation/actions/runs/34946597355",
};

describe("buildCriticalPayload: 行動可能な本文", () => {
  it("何が起きたかが日本語の1行で出る", () => {
    const c = buildCriticalPayload(base, undefined).content!;
    expect(c).toContain("本番デプロイが失敗");
  });

  it("どこを見るか（evidence_url）が出る", () => {
    const c = buildCriticalPayload(base, undefined).content!;
    expect(c).toContain(base.evidenceUrl);
  });

  it("次にすべきことが出る", () => {
    const c = buildCriticalPayload(base, undefined).content!;
    expect(c).toContain("対応:");
    expect(c).toContain("ログ");
  });

  it("証跡IDと対象は残す（追跡の起点）", () => {
    const c = buildCriticalPayload(base, undefined).content!;
    expect(c).toContain("e-300");
    expect(c).toContain(base.target);
  });

  /**
   * テンプレートが無いからといって情報を減らしてはいけない。
   * 「何が起きたか」は agent_id + action から機械的に作れる。
   */
  it("未知の error_kind でも最低限の3要素が出る", () => {
    const c = buildCriticalPayload(
      { ...base, errorKind: "全く未知のエラー種別", action: "unknown-action" },
      undefined,
    ).content!;
    expect(c).toContain("unknown-action");
    expect(c).toContain(base.evidenceUrl);
    expect(c).toContain("対応:");
  });

  it("evidence_url が無ければ「証跡IDで照会」に倒す（空欄にしない）", () => {
    const c = buildCriticalPayload({ ...base, evidenceUrl: undefined }, undefined).content!;
    expect(c).toContain("e-300");
    expect(c).not.toContain("undefined");
    expect(c).toContain("証跡");
  });

  it("メンションは先頭に付き、allowed_mentions で対象を絞る", () => {
    const p = buildCriticalPayload(base, "123456789");
    expect(p.content!.startsWith("<@123456789>")).toBe(true);
    expect(p.allowed_mentions).toEqual({ users: ["123456789"] });
  });

  it("メンション未設定なら誰も鳴らさない", () => {
    const p = buildCriticalPayload(base, undefined);
    expect(p.allowed_mentions).toEqual({ parse: [] });
  });

  describe("error_kind ごとのテンプレート", () => {
    const content = (errorKind: string, over: Record<string, unknown> = {}) =>
      buildCriticalPayload({ ...base, errorKind, ...over }, undefined).content!;

    it("binding-missing: 何が欠けたかと復旧手順", () => {
      const c = content("binding-missing:NOTIFY_GW", { action: "binding-drift", target: "期待バインディング欠落: NOTIFY_GW" });
      expect(c).toContain("バインディング");
      expect(c).toContain("NOTIFY_GW");
      expect(c).toContain("対応:");
    });

    it("binding-report-stale: 申告が途絶した旨と確認先", () => {
      const c = content("binding-report-stale", { action: "binding-report-stale" });
      expect(c).toContain("申告が届いていません");
      expect(c).toContain("対応:");
    });

    it("job-failure: どのジョブが落ちたか", () => {
      const c = content("job-failure", { agentId: "tagtech-cron/pipeline-daily", action: "run" });
      expect(c).toContain("tagtech-cron/pipeline-daily");
      expect(c).toContain("対応:");
    });

    it("unmapped-cron: 対応表に無い cron", () => {
      const c = content("unmapped-cron", { action: "unmapped-cron", target: "0 21 * * *" });
      expect(c).toContain("cron");
      expect(c).toContain("0 21 * * *");
    });
  });

  it("Discord の文字数上限に収まる長さで作る", () => {
    const c = buildCriticalPayload(
      { ...base, target: "x".repeat(3000) },
      "123456789",
    ).content!;
    // sendDiscord 側でも切るが、組み立て時点で暴走しないこと
    expect(c.length).toBeLessThanOrEqual(1900);
  });
});
