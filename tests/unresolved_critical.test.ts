/**
 * 未解消 CRITICAL の持ち越し。
 *
 * なぜ要るか:
 *   2026-09-15 から3日間、tagtech-automation の Deploy が失敗し続けた。
 *   証跡層は正しく働いていた — CRITICAL として記録し、#alerts にも送り、
 *   日報の「失敗・CRITICAL」欄にも出していた。**それでも誰も気づかなかった。**
 *
 *   原因は仕組みではなく、「日報の CRITICAL 欄を毎朝見る」という運用が
 *   人の注意力に依存していたこと。1日分の日報は翌日には流れてしまい、
 *   見逃した異常は二度と目に入らない。
 *
 * 対処:
 *   **解消されていない異常は、解消されるまで毎日繰り返し報告する。**
 *   同じ agent_id + action で success が記録された時点で自動的に解消とみなす。
 *   人の「確認済み」操作は設けない(人の操作に依存すると、それ自体が忘れられる)。
 */
import { describe, expect, it } from "vitest";
import { buildUnresolvedSection, type UnresolvedCritical } from "../src/lib/unresolved";

const mk = (over: Partial<UnresolvedCritical> = {}): UnresolvedCritical => ({
  agent_id: "github-actions/tagtech-automation",
  action: "deploy",
  summary: "デプロイ失敗",
  first_id: 300,
  first_ts: "2026-09-15T08:22:00.000Z",
  count: 1,
  ...over,
});

const NOW = Date.parse("2026-09-18T00:05:00.000Z");

describe("buildUnresolvedSection: 日報の先頭に出す持ち越し", () => {
  it("0件なら何も出さない（平常時に行を増やさない）", () => {
    expect(buildUnresolvedSection([], NOW)).toEqual([]);
  });

  /**
   * 経過日数は**切り捨て**。実例の 2026-09-15T08:22 → 2026-09-18T00:05 は
   * 2日と約16時間なので「2日前」になる。
   * 切り上げると実際より長く見え、切り捨てなら短く見える。どちらかに倒すしかないので、
   * 「少なくともこれだけ放置されている」と読める切り捨てを採る。
   */
  it("件数と最古の経過日数を見出しに出す（日数は切り捨て）", () => {
    const lines = buildUnresolvedSection([mk()], NOW);
    expect(lines[0]).toContain("未解消 CRITICAL: 1件");
    expect(lines[0]).toContain("最古: 2日前");
  });

  it("同日なら「本日」と出す（0日前と書かない）", () => {
    const lines = buildUnresolvedSection([mk({ first_ts: "2026-09-18T00:00:00.000Z" })], NOW);
    expect(lines[0]).toContain("最古: 本日");
  });

  it("最古は first_ts が最も古いものを採る", () => {
    const lines = buildUnresolvedSection(
      [
        mk({ agent_id: "a", first_ts: "2026-09-17T00:00:00.000Z" }),
        mk({ agent_id: "b", first_ts: "2026-09-12T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(lines[0]).toContain("2件");
    expect(lines[0]).toContain("最古: 6日前");
  });

  it("各行に agent_id / action / 証跡ID / 経過日数が出る", () => {
    const body = buildUnresolvedSection([mk()], NOW).join("\n");
    expect(body).toContain("github-actions/tagtech-automation");
    expect(body).toContain("deploy");
    expect(body).toContain("e-300");
    expect(body).toContain("2日");
  });

  /**
   * 畳まないと洪水になる。同じジョブが3日失敗し続ければ3件ではなく1件として数え、
   * 回数を添える。畳む単位は agent_id + action。
   */
  it("回数が複数なら ×N回 を添える（畳んだ結果であることを示す）", () => {
    const body = buildUnresolvedSection([mk({ count: 3 })], NOW).join("\n");
    expect(body).toContain("×3回");
  });

  it("回数1なら ×N回 を付けない（冗長にしない）", () => {
    const body = buildUnresolvedSection([mk({ count: 1 })], NOW).join("\n");
    expect(body).not.toContain("×1回");
  });

  it("古いものから順に並ぶ（放置が長いものほど上）", () => {
    const lines = buildUnresolvedSection(
      [
        mk({ agent_id: "new", first_ts: "2026-09-17T00:00:00.000Z" }),
        mk({ agent_id: "old", first_ts: "2026-09-10T00:00:00.000Z" }),
      ],
      NOW,
    );
    const body = lines.join("\n");
    expect(body.indexOf("old")).toBeLessThan(body.indexOf("new"));
  });

  /**
   * Discord は 2000 字上限。持ち越しが増えたときに日報本体を押し出してはいけない。
   * 上位5件に絞り、残りは件数だけ示す。
   */
  it("6件以上は上位5件だけ出し、残りは件数で示す", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      mk({ agent_id: `agent-${i}`, first_ts: `2026-09-1${i % 8}T00:00:00.000Z` }),
    );
    const lines = buildUnresolvedSection(rows, NOW);
    expect(lines[0]).toContain("8件");
    // 「他N件」も字下げされているので、明細行だけを数えるには証跡IDの有無で見る
    expect(lines.filter((l) => l.includes("証跡ID")).length).toBe(5);
    expect(lines.join("\n")).toContain("他3件");
  });

  it("見出しは区切り線で囲まれ、日報本体と見分けがつく", () => {
    const lines = buildUnresolvedSection([mk()], NOW);
    expect(lines[0]).toMatch(/^──.*──$/);
  });
});

/**
 * #alerts 送信失敗(discord_sent=0)は、新しい解消条件を作らず既存の持ち越しに乗せる(判断2)。
 * 元の異常(agent_id+action)が success で解消されれば、送信失敗のマーカーごと消える。
 */
describe("#alerts送信失敗のマーカー(判断2)", () => {
  it("alert_failed > 0 なら行末に ⚠#alerts未達 を付ける", () => {
    const body = buildUnresolvedSection([mk({ alert_failed: 1 })], NOW).join("\n");
    expect(body).toContain("⚠#alerts未達");
  });

  it("alert_failed が 0 または未指定なら付けない", () => {
    const zero = buildUnresolvedSection([mk({ alert_failed: 0 })], NOW).join("\n");
    const undef = buildUnresolvedSection([mk()], NOW).join("\n");
    expect(zero).not.toContain("⚠#alerts未達");
    expect(undef).not.toContain("⚠#alerts未達");
  });
});

/**
 * 死活異常（バインディング申告の途絶・欠落）も持ち越しに含める。
 *
 * 2026-09-15 から tagtech-cron の申告が途絶し、日報の「死活・バインディング異常」欄に
 * 出続けていたが2日間気づかれなかった。CRITICAL と同じ性質
 * （解消されるまで続く異常）なので、同じ場所で繰り返す。
 *
 * ただし解消の判定は success の記録ではなく「申告が届いたか」で行う。
 * 途絶している間は notify-gw 側が毎日新しい CRITICAL を出すので、
 * イベント経由でも拾えるが、**申告が無いこと自体**を直接見るほうが確実。
 */
describe("死活異常も持ち越しに含める", () => {
  const drift = (over: Partial<UnresolvedCritical> = {}): UnresolvedCritical => ({
    agent_id: "tagtech-cron",
    action: "binding-report-stale",
    summary: "申告途絶(最終 2026-09-15T00:05:43.441Z)",
    first_id: 429,
    first_ts: "2026-09-15T00:05:43.441Z",
    count: 1,
    ...over,
  });

  it("CRITICAL と同じ一覧に並ぶ", () => {
    const body = buildUnresolvedSection([drift()], NOW).join("\n");
    expect(body).toContain("tagtech-cron");
    expect(body).toContain("binding-report-stale");
    expect(body).toContain("申告途絶");
  });

  it("CRITICAL と混在しても古い順に並ぶ", () => {
    const body = buildUnresolvedSection(
      [mk({ agent_id: "newer", first_ts: "2026-09-16T00:00:00.000Z" }), drift()],
      NOW,
    ).join("\n");
    expect(body.indexOf("tagtech-cron")).toBeLessThan(body.indexOf("newer"));
  });

  it("件数に合算される（別枠にしない）", () => {
    const lines = buildUnresolvedSection([mk(), drift()], NOW);
    expect(lines[0]).toContain("2件");
  });
});
