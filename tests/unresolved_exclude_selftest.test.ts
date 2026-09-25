/**
 * 未解消 CRITICAL の判定から、notify-gw 自身の selftest を除外する。
 *
 * なぜ要るか:
 *   Phase1 の受け入れ検証(2026-09-10)で、CRITICAL 経路が動くことを確かめるために
 *   `notify-gw/selftest phase1-verify` を result=failure / severity=CRITICAL で
 *   意図的に2件記録した(e-2 / e-3)。これは「解消すべき異常」ではないが、
 *   同じ agent_id + action の success が後に来ないため、持ち越し判定では
 *   永久に「未解消 CRITICAL: 1件(最古: N日前)」として日報の先頭に居座る。
 *
 * なぜ success を書いて消さないか:
 *   証跡は追記専用で、起きていない success を書くのは嘘の証跡になる
 *   (社長判断 2026-09-20: 「除外条件で対応、嘘の success は書かない」)。
 *
 * 除外の範囲:
 *   agent_id が 'notify-gw/selftest' で始まるものだけ。運用ジョブ(notify-gw 本体の
 *   digest 送信や github-actions/... など)には一切効かない。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dbSrc = readFileSync(fileURLToPath(new URL("../src/lib/db.ts", import.meta.url)), "utf-8");

function unresolvedSql(): string {
  const start = dbSrc.indexOf("export async function listUnresolvedCriticals");
  const end = dbSrc.indexOf("}", dbSrc.indexOf(".all<UnresolvedCriticalRow>()", start));
  expect(start, "listUnresolvedCriticals が見つからない").toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = dbSrc.slice(start, end);
  expect(body.length).toBeGreaterThan(0);
  return body;
}

describe("listUnresolvedCriticals: selftest の除外", () => {
  it("agent_id が notify-gw/selftest% の行を判定から外す", () => {
    expect(unresolvedSql()).toMatch(/AND\s+c\.agent_id\s+NOT\s+LIKE\s+'notify-gw\/selftest%'/);
  });

  it("除外は外側の CRITICAL 抽出(c)にだけ掛かり、解消判定(s)の success 側には掛けない", () => {
    const sql = unresolvedSql();
    const notExistsPos = sql.indexOf("NOT EXISTS");
    const excludePos = sql.indexOf("NOT LIKE 'notify-gw/selftest%'");
    expect(notExistsPos).toBeGreaterThan(0);
    expect(excludePos).toBeGreaterThan(0);
    expect(excludePos, "除外条件は NOT EXISTS より前(外側の WHERE)にあること").toBeLessThan(notExistsPos);
    // s 側(解消判定)には selftest の条件を書かない: 書くと将来 selftest が success を
    // 記録しても解消扱いにならず、除外の意図と食い違う
    expect(sql.slice(notExistsPos)).not.toContain("selftest");
  });

  it("運用ジョブの agent_id 接頭辞は除外パターンに含まれない(誤って広げていない)", () => {
    const sql = unresolvedSql();
    expect(sql).not.toMatch(/NOT LIKE\s+'notify-gw%'/); // notify-gw 本体まで消してはいけない
    expect(sql).not.toMatch(/NOT LIKE\s+'%selftest%'/); // 前方一致に限定
  });
});
