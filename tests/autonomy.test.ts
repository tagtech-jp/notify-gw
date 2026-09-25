import { describe, expect, it } from "vitest";
import { createFakeD1 } from "./helpers/fakeD1";
import { insertEvent } from "../src/lib/db";

/**
 * 自律度ビューは「窓 = 実行時刻から見た直近28 JST日」で動くため、テストは
 * 現在時刻を基準に相対日付でイベントを作る。JST日D の 00:00 = UTC (D-1) 15:00。
 */
/** seed(0005)より新しい断面としてテストが使う batch_id */
const TEST_BATCH = "2099-01-01T00:00:00.000Z";

function jstDaysAgoIso(days: number, hourUtc = 3): string {
  // 起点は必ず JST の日付にする。集計窓が date('now','+9 hours') 基準なので、
  // UTC の日付を起点にすると UTC 15:00〜24:00(JST の翌日 00:00〜09:00)の間だけ
  // 1日ずれて最古のイベントが窓の外に落ちる。
  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const d = new Date(Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate() - days, hourUtc, 0, 0));
  return d.toISOString();
}

async function seedLedger(
  db: D1Database,
  rows: Array<{
    agent_id: string;
    role_ja?: string;
    level?: string;
    job_id: string | null;
    cron?: string | null;
    expected?: number;
  }>,
  // migrations/0005 の実データ(92行・batch_id=2026-09-14)が既に入っているため、
  // テストは常にそれより新しい batch_id を使い、agent_ledger_current を自分の断面に隔離する。
  batchId = TEST_BATCH,
): Promise<void> {
  for (const r of rows) {
    await db
      .prepare(
        `INSERT INTO agent_ledger (batch_id, agent_id, role_ja, level, department, worker, job_id, cron, expected_days_28d, model, source, note)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'test-model', 'tests/autonomy.test.ts', NULL)`,
      )
      .bind(
        batchId,
        r.agent_id,
        r.role_ja ?? "テスト役職",
        r.level ?? "CxO",
        r.job_id === null ? null : "tagtech-automation",
        r.job_id,
        r.cron ?? null,
        r.expected ?? 0,
      )
      .run();
  }
}

/** 集計窓を固定する。0007 で入れた上書き表を使い、暦に依存するケースを決定論的に検証する。 */
async function setWindow(db: D1Database, startUtc: string, endUtc: string): Promise<void> {
  await db
    .prepare(`INSERT INTO autonomy_window_override (start_utc, end_utc) VALUES (?, ?)`)
    .bind(startUtc, endUtc)
    .run();
}

/** JST 日付(YYYY-MM-DD)の 00:00 に対応する UTC ISO 文字列。JST日D の 00:00 = UTC (D-1) 15:00 */
function jstDayStartUtc(jstDate: string): string {
  const ms = Date.parse(`${jstDate}T00:00:00.000Z`) - 9 * 3600 * 1000;
  return new Date(ms).toISOString();
}

/**
 * seed 由来の集計値を固定値と比較するテスト専用の読み取り経路。
 * 窓が live のままなら読ませずに落とす。
 *
 * roles_measured のように seed のスケジュールから決まる値は、28日窓が実時間で
 * スライドするため、窓を固定しないと必ずいつか期限切れする。
 * 実例(2026-09-17 JST): roles_measured の 15 が 14 になって CI が赤になった。
 * CPO の唯一の実行実体 cpo_platform_review が毎月20日 cron で、2026-08-20 が
 * 窓外に出たため(2026-09-20 は未来なので窓内に候補日が1つも無くなった)。
 * 期待値に日付が現れないので、時刻依存だと気づきにくいのがこの事故の質である。
 *
 * このガードがあると、窓固定を忘れた固定値比較は「15 !== 14」ではなく
 * 「窓を固定してください」で落ちるので、原因がその場で分かる。
 */
async function pinnedOrgSummary(db: D1Database): Promise<Record<string, number | string>> {
  const w = await db
    .prepare(`SELECT window_source FROM autonomy_window`)
    .first<{ window_source: string }>();
  if (w?.window_source !== "override") {
    throw new Error(
      "seed 由来の集計値を固定値と比較する前に setWindow() で窓を固定してください" +
        `(window_source=${w?.window_source ?? "unknown"})。` +
        "28日窓は実時間でスライドするため、固定しないと将来必ず期限切れします。",
    );
  }
  return (await db
    .prepare(`SELECT * FROM autonomy_org_summary`)
    .first<Record<string, number | string>>())!;
}

async function addSchedule(
  db: D1Database,
  jobId: string,
  cron: string,
  kind: "hourly" | "daily" | "weekly" | "monthly",
  dom: number | null,
  expected: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO job_schedule (job_id, worker, cron, cron_kind, cron_dom, expected_days_28d, source)
       VALUES (?, 'tagtech-automation', ?, ?, ?, ?, 'tests/autonomy.test.ts')`,
    )
    .bind(jobId, cron, kind, dom, expected)
    .run();
}

async function mapMetric(db: D1Database, jobId: string, metric: string): Promise<void> {
  // 0005 の seed が同じ分類を既に入れている場合があるので衝突は無視する
  await db
    .prepare(`INSERT OR IGNORE INTO autonomy_metric_map (job_id, metric, source) VALUES (?, ?, 'tests')`)
    .bind(jobId, metric)
    .run();
}

async function event(
  db: D1Database,
  args: {
    agent_id: string;
    daysAgo: number;
    action?: string;
    result?: "success" | "failure" | "skip";
    severity?: "CRITICAL" | "WARN" | "INFO";
    meta?: string | undefined;
    evidence_url?: string;
  },
): Promise<void> {
  await insertEvent(db, {
    ts: jstDaysAgoIso(args.daysAgo),
    agent_id: args.agent_id,
    action: args.action ?? "run",
    result: args.result ?? "success",
    severity: args.severity ?? "INFO",
    fingerprint: `fp-${args.agent_id}-${args.daysAgo}-${args.action ?? "run"}`,
    meta: args.meta,
    evidence_url: args.evidence_url,
  });
}

interface AutonomyRow {
  subject: string;
  agent_id: string | null;
  ledger_registered: number;
  m1_report: number | null;
  m2_exec: number | null;
  m3_intake: number | null;
  m4_trace: number | null;
  m5_improve: number | null;
  m6_judge: number | null;
  expected_days: number;
  success_days: number;
  exec_days: number;
  events_total: number;
  failure_total: number;
  decision_kinds: number;
}

function row(db: D1Database, subject: string) {
  return db.prepare(`SELECT * FROM autonomy_v1 WHERE subject = ?`).bind(subject).first<AutonomyRow>();
}

describe("agent_ledger (追記専用の物理ガード)", () => {
  it("UPDATE と DELETE をトリガで拒否する", async () => {
    const db = createFakeD1();
    await seedLedger(db, [{ agent_id: "CFO", job_id: "tagtech-automation/cfo_finance_report", expected: 28 }]);

    await expect(db.prepare(`UPDATE agent_ledger SET active = 0`).run()).rejects.toThrow(/append-only/);
    await expect(db.prepare(`DELETE FROM agent_ledger`).run()).rejects.toThrow(/append-only/);

    const kept = await db
      .prepare(`SELECT COUNT(*) c FROM agent_ledger WHERE batch_id = ?`)
      .bind(TEST_BATCH)
      .first<{ c: number }>();
    expect(kept?.c).toBe(1);
    // 0005 seed の 92 行も消えていない
    const seeded = await db
      .prepare(`SELECT COUNT(*) c FROM agent_ledger WHERE batch_id = '2026-09-14T00:00:00.000Z'`)
      .first<{ c: number }>();
    expect(seeded?.c).toBe(92);
  });

  it("agent_ledger_current は最新 batch_id の断面だけを返す(訂正は新batchの追記)", async () => {
    const db = createFakeD1();
    await seedLedger(db, [{ agent_id: "CSO", job_id: "tagtech-automation/cso_ghost", expected: 28 }], TEST_BATCH);
    // 実体なしへの訂正を、さらに新しい batch で追記する
    await seedLedger(db, [{ agent_id: "CSO", job_id: null }], "2099-02-01T00:00:00.000Z");

    const rows = await db
      .prepare(`SELECT agent_id, job_id FROM agent_ledger_current`)
      .all<{ agent_id: string; job_id: string | null }>();
    expect(rows.results).toEqual([{ agent_id: "CSO", job_id: null }]);

    const history = await db
      .prepare(`SELECT COUNT(*) c FROM agent_ledger WHERE agent_id = 'CSO' AND batch_id LIKE '2099%'`)
      .first<{ c: number }>();
    expect(history?.c).toBe(2); // 履歴は消えない
  });
});

describe("autonomy_v1 (0〜5の決定論的な点数)", () => {
  it("日次ジョブが28日すべて成功すると 5 点、対象外項目は NULL", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/cfo_finance_report";
    await seedLedger(db, [{ agent_id: "CFO", job_id: job, cron: "30 23 * * *", expected: 28 }]);
    await mapMetric(db, job, "report");
    for (let d = 1; d <= 28; d++) await event(db, { agent_id: job, daysAgo: d, meta: '{"elapsed_ms":10}' });

    const r = await row(db, job);
    expect(r).toMatchObject({ m1_report: 5, m2_exec: 5, m4_trace: 5, ledger_registered: 1 });
    expect(r?.m3_intake).toBeNull(); // 情報収集の担当ではない
    expect(r?.m5_improve).toBeNull(); // 自己改善の担当ではない
    expect(r?.success_days).toBe(28);
    expect(r?.expected_days).toBe(28);
  });

  it("週次ジョブは4回成功で 5 点になる(暦で不利にならないことの証明)", async () => {
    const db = createFakeD1();
    // pipeline_weekly は 2026-09-21 の 0014 で job_schedule から外れた(automation 側で降格)ため、
    // 0014 に残っている週次ジョブを使う。expected_days は job_schedule 由来なので、
    // ここで seed する ledger の cron だけ合わせても schedule に無いジョブは NULL になる。
    const job = "tagtech-automation/weekly_ceo_meeting";
    await seedLedger(db, [{ agent_id: "CEO", job_id: job, cron: "0 2 * * 1", expected: 4 }]);
    await mapMetric(db, job, "report");
    for (const d of [3, 10, 17, 24]) await event(db, { agent_id: job, daysAgo: d, meta: "{}" });

    const r = await row(db, job);
    expect(r?.success_days).toBe(4);
    expect(r?.expected_days).toBe(4);
    expect(r?.m1_report).toBe(5);
    expect(r?.m2_exec).toBe(5);
  });

  it("達成率でバンドが下がる(14/28日=50% は 2 点)", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/daily_standup";
    await seedLedger(db, [{ agent_id: "CHRO", job_id: job, cron: "0 23 * * *", expected: 28 }]);
    await mapMetric(db, job, "report");
    for (let d = 1; d <= 14; d++) await event(db, { agent_id: job, daysAgo: d, meta: "{}" });

    const r = await row(db, job);
    expect(r?.success_days).toBe(14);
    expect(r?.m1_report).toBe(2); // 50% → 30%以上60%未満
  });

  it("実行実体のない役職は 0 点ではなく NULL(未測定)になる", async () => {
    const db = createFakeD1();
    await seedLedger(db, [
      { agent_id: "CSO", role_ja: "最高戦略責任者", job_id: null },
      { agent_id: "BU_開発部", role_ja: "開発部長", level: "部長", job_id: null },
    ]);

    const roles = await db
      .prepare(`SELECT agent_id, entity_count, m_role_cadence FROM autonomy_v1_by_role ORDER BY agent_id`)
      .all<{ agent_id: string; entity_count: number; m_role_cadence: number | null }>();
    // 0点(やるべきなのにやっていない)と未測定(そもそも実体が無い)を混同すると組織平均が不当に沈む
    expect(roles.results).toEqual([
      { agent_id: "BU_開発部", entity_count: 0, m_role_cadence: null },
      { agent_id: "CSO", entity_count: 0, m_role_cadence: null },
    ]);

    // job_id が NULL の役職は実体単位のビューには現れない
    const listed = await db
      .prepare(`SELECT COUNT(*) c FROM autonomy_v1 WHERE agent_id IN ('CSO','BU_開発部')`)
      .first<{ c: number }>();
    expect(listed?.c).toBe(0);
  });

  it("失敗しか出していない実体は実行 0 点だが、証跡記録は評価される", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/broken_job";
    await seedLedger(db, [{ agent_id: "CTO", job_id: job, cron: "0 0 * * *", expected: 28 }]);
    await addSchedule(db, job, "0 0 * * *", "daily", null, 28);
    for (let d = 1; d <= 10; d++) {
      await event(db, { agent_id: job, daysAgo: d, result: "failure", severity: "CRITICAL", meta: '{"error":"boom"}' });
    }

    const r = await row(db, job);
    expect(r).toMatchObject({ m2_exec: 0, m4_trace: 5, success_days: 0, failure_total: 10 });
    expect(r?.m1_report).toBeNull();
  });

  it("meta も evidence_url も無い証跡は追跡可能率を下げる", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/opaque_job";
    await seedLedger(db, [{ agent_id: "CAO", job_id: job, cron: "0 0 * * *", expected: 28 }]);
    for (let d = 1; d <= 8; d++) await event(db, { agent_id: job, daysAgo: d }); // meta 無し
    for (let d = 9; d <= 10; d++) await event(db, { agent_id: job, daysAgo: d, meta: "{}" });

    const r = await row(db, job);
    expect(r?.events_total).toBe(10);
    expect(r?.m4_trace).toBe(2); // 2/10 = 20% → 2点
  });

  it("自律判断は判断種別の数で決まる(低頻度でも評価される)", async () => {
    const db = createFakeD1();
    const job = "tagtech-cron/funding-reminder";
    await seedLedger(db, [{ agent_id: "CLO", job_id: job, cron: "0 0 * * *", expected: 28 }]);
    await event(db, { agent_id: job, daysAgo: 2, action: "deadline-approaching", severity: "WARN" });
    await event(db, { agent_id: job, daysAgo: 3, action: "deadline-overdue", severity: "WARN" });
    await event(db, { agent_id: job, daysAgo: 4, result: "skip" });
    await event(db, { agent_id: job, daysAgo: 5 }); // 通常実行は判断に数えない

    const r = await row(db, job);
    expect(r?.decision_kinds).toBe(3); // deadline-approaching / deadline-overdue / skip
    expect(r?.m6_judge).toBe(3);
  });

  it("台帳未登録なのに動いている実体も隠さず現れる(期待値は日次と仮定)", async () => {
    const db = createFakeD1();
    const job = "tagtech-cron/heartbeat";
    for (let d = 1; d <= 28; d++) await event(db, { agent_id: job, daysAgo: d, meta: "{}" });

    const r = await row(db, job);
    expect(r).toMatchObject({ ledger_registered: 0, m2_exec: 5, expected_days: 28 });
    expect(r?.agent_id).toBeNull(); // 役職に紐づいていない
  });

  it("窓の外(29日以上前)の証跡は数えない", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/old_job";
    await seedLedger(db, [{ agent_id: "CDO", job_id: job, cron: "0 0 * * *", expected: 28 }]);
    await addSchedule(db, job, "0 0 * * *", "daily", null, 28);
    for (let d = 30; d <= 40; d++) await event(db, { agent_id: job, daysAgo: d, meta: "{}" });

    const r = await row(db, job);
    expect(r).toMatchObject({ events_total: 0, m2_exec: 0, m4_trace: 0 });
  });

  it("複数ジョブを持つ役職は成功日の和集合と期待値の合計で評価する", async () => {
    const db = createFakeD1();
    const a = "tagtech-automation/cmo_sns_noon";
    const b = "tagtech-automation/cmo_sns_night";
    await seedLedger(db, [
      { agent_id: "CMO", job_id: a, cron: "0 3 * * *", expected: 28 },
      { agent_id: "CMO", job_id: b, cron: "0 13 * * *", expected: 28 },
    ]);
    // 同じ日に両方成功しても「その役職が稼働した日」は1日として数える
    for (let d = 1; d <= 28; d++) {
      await event(db, { agent_id: a, daysAgo: d, meta: "{}" });
      await event(db, { agent_id: b, daysAgo: d, meta: "{}" });
    }

    const r = await db
      .prepare(`SELECT entity_count, expected_days, success_days, m_role_cadence FROM autonomy_v1_by_role WHERE agent_id='CMO'`)
      .first<{ entity_count: number; expected_days: number; success_days: number; m_role_cadence: number }>();
    expect(r).toMatchObject({ entity_count: 2, expected_days: 56, success_days: 28 });
    // 和集合28日 / 期待56日 = 50% → 30%以上60%未満なので 2 点。
    // 2ジョブが同じ日に成功しても「稼働した日」は1日と数えるため、満点にはならない。
    expect(r?.m_role_cadence).toBe(2);
  });

  it("台帳未登録でも job_schedule があれば期待値は cron 由来になる(週次を日次と誤認しない)", async () => {
    const db = createFakeD1();
    const r = await db
      .prepare(`SELECT cron_kind, expected_days, expected_basis FROM autonomy_v1 WHERE subject = 'tagtech-cron/seo-checker'`)
      .first<{ cron_kind: string; expected_days: number; expected_basis: string }>();
    // 修正前は台帳に cron が無いため一律 28 と仮定しており、週次ジョブを7倍過小評価していた
    expect(r).toMatchObject({ cron_kind: "weekly", expected_days: 4, expected_basis: "schedule" });
  });

  it("同じ入力なら同じ点数になる(決定論)", async () => {
    const build = async () => {
      const db = createFakeD1();
      const job = "tagtech-automation/cio_daily_news";
      await seedLedger(db, [{ agent_id: "CIO", job_id: job, cron: "0 0 * * *", expected: 28 }]);
      await mapMetric(db, job, "intake");
      for (let d = 1; d <= 20; d++) await event(db, { agent_id: job, daysAgo: d, meta: "{}" });
      return row(db, job);
    };
    const first = await build();
    const second = await build();
    expect(first?.m3_intake).toBe(second?.m3_intake);
    expect(first?.success_days).toBe(second?.success_days);
  });
});

/**
 * 月次ジョブの期待値は「窓に対象日が含まれるか」で決まる。集計窓は now で動くので、
 * autonomy_window_override で窓を固定して暦依存のケースを決定論的に検証する。
 * 対象は seed(0010)に実在する3件: cfo_monthly_report / monthly_fixed_expenses (毎月1日)、
 * cpo_platform_review (毎月20日)。
 */
describe("月次ジョブの期待値(窓ごとの再計算)", () => {
  const MONTHLY_JOB = "tagtech-automation/cfo_monthly_report"; // 毎月1日
  const DOM20_JOB = "tagtech-automation/cpo_platform_review"; // 毎月20日

  async function expectedOf(db: D1Database, jobId: string): Promise<number | null> {
    const r = await db
      .prepare(`SELECT expected_days FROM job_expected WHERE job_id = ?`)
      .bind(jobId)
      .first<{ expected_days: number | null }>();
    return r?.expected_days ?? null;
  }

  it("窓が対象日を含まないとき期待値は 0 になり、全項目 NULL(未測定)になる", async () => {
    const db = createFakeD1();
    // JST 2026-09-02 〜 2026-09-29 の28日。1日を含まない
    await setWindow(db, jstDayStartUtc("2026-09-02"), jstDayStartUtc("2026-09-30"));
    expect(await expectedOf(db, MONTHLY_JOB)).toBe(0);

    const r = await db
      .prepare(`SELECT m1_report, m2_exec, m4_trace, m6_judge, expected_days FROM autonomy_v1 WHERE subject = ?`)
      .bind(MONTHLY_JOB)
      .first<Record<string, number | null>>();
    // 修正前は max(...,1) の切り上げで「1日は動くべき」と誤って要求し m2_exec=0 になっていた
    expect(r?.expected_days).toBe(0);
    expect(r?.m2_exec).toBeNull();
    expect(r?.m1_report).toBeNull();
    expect(r?.m4_trace).toBeNull();
    expect(r?.m6_judge).toBeNull();
  });

  it("窓が対象日を含み、その日に実行していれば満点になる", async () => {
    const db = createFakeD1();
    await setWindow(db, jstDayStartUtc("2026-08-17"), jstDayStartUtc("2026-09-14")); // 9/1 を含む
    expect(await expectedOf(db, MONTHLY_JOB)).toBe(1);

    await insertEvent(db, {
      ts: "2026-09-01T03:00:00.000Z", // JST 9/1 12:00
      agent_id: MONTHLY_JOB,
      action: "run",
      result: "success",
      severity: "INFO",
      fingerprint: "fp-monthly-ok",
      meta: "{}",
    });

    const r = await db
      .prepare(`SELECT m1_report, m2_exec, exec_days FROM autonomy_v1 WHERE subject = ?`)
      .bind(MONTHLY_JOB)
      .first<Record<string, number | null>>();
    expect(r).toMatchObject({ exec_days: 1, m2_exec: 5, m1_report: 5 });
  });

  it("窓が対象日を含むのに実行していなければ 0 点になる(真の検知は潰さない)", async () => {
    const db = createFakeD1();
    await setWindow(db, jstDayStartUtc("2026-08-17"), jstDayStartUtc("2026-09-14"));
    const r = await db
      .prepare(`SELECT m2_exec, expected_days FROM autonomy_v1 WHERE subject = ?`)
      .bind(MONTHLY_JOB)
      .first<Record<string, number | null>>();
    expect(r).toMatchObject({ expected_days: 1, m2_exec: 0 });
  });

  it("月末をまたぐ窓でも対象日は1回しか数えない", async () => {
    const db = createFakeD1();
    // JST 2026-01-30 〜 2026-02-26。2/1 を1回だけ含む
    await setWindow(db, jstDayStartUtc("2026-01-30"), jstDayStartUtc("2026-02-27"));
    expect(await expectedOf(db, MONTHLY_JOB)).toBe(1);
  });

  it("月初をまたぐ窓で二重計上しない(候補が2つの月から出ても1回)", async () => {
    const db = createFakeD1();
    // JST 2026-02-01 〜 2026-02-28。窓の開始月と終端月がまたがっても 2/1 の1回だけ
    await setWindow(db, jstDayStartUtc("2026-02-01"), jstDayStartUtc("2026-03-01"));
    expect(await expectedOf(db, MONTHLY_JOB)).toBe(1);
  });

  it("20日をまたぐ窓で毎月20日のジョブが減点されない", async () => {
    const db = createFakeD1();
    await setWindow(db, jstDayStartUtc("2026-08-17"), jstDayStartUtc("2026-09-14")); // 8/20 を含む
    expect(await expectedOf(db, DOM20_JOB)).toBe(1);

    // 8/20 も 9/20 も含まない窓は、同じ db では検証できない。autonomy_window が
    // COALESCE((SELECT ... FROM autonomy_window_override LIMIT 1), ...) で1行目しか
    // 読まないため、2回目の setWindow は効かない。別 DB を作って検証する。
    const db2 = createFakeD1();
    await setWindow(db2, jstDayStartUtc("2026-08-21"), jstDayStartUtc("2026-09-18"));
    expect(await expectedOf(db2, DOM20_JOB)).toBe(0);
    const r = await db2
      .prepare(`SELECT m2_exec FROM autonomy_v1 WHERE subject = ?`)
      .bind(DOM20_JOB)
      .first<{ m2_exec: number | null }>();
    expect(r?.m2_exec).toBeNull();
  });

  it("存在しない日付(30日までの月の31日)は発火扱いしない", async () => {
    const db = createFakeD1();
    await addSchedule(db, "tagtech-automation/dom31_job", "0 0 31 * *", "monthly", 31, 1);
    // JST 2026-04-05 〜 2026-05-02。4月は30日までなので4/31は存在しない
    await setWindow(db, jstDayStartUtc("2026-04-05"), jstDayStartUtc("2026-05-03"));
    expect(await expectedOf(db, "tagtech-automation/dom31_job")).toBe(0);
  });

  it("窓を上書きすると window_source が override になる(消し忘れを検知できる)", async () => {
    const db = createFakeD1();
    const before = await db.prepare(`SELECT window_source FROM autonomy_window`).first<{ window_source: string }>();
    expect(before?.window_source).toBe("live");

    await setWindow(db, jstDayStartUtc("2026-08-17"), jstDayStartUtc("2026-09-14"));
    const after = await db.prepare(`SELECT window_source FROM autonomy_window`).first<{ window_source: string }>();
    expect(after?.window_source).toBe("override");

    const summary = await db
      .prepare(`SELECT window_source, window_start FROM autonomy_org_summary`)
      .first<{ window_source: string; window_start: string }>();
    expect(summary?.window_source).toBe("override");
    expect(summary?.window_start).toBe(jstDayStartUtc("2026-08-17"));
  });
});

/**
 * ⑥自律判断に数えてよいのは「入力に応じて結果が変わりうる判断」だけ。
 * 固定値を返すスタブ・未移植マーカー・定数レスポンスは対象外(RUNBOOK §6-1)。
 * 0011 以前は未移植スタブが m6_judge=1 を獲得しており、m2_exec=0 なのに
 * 判断力があることになっていた(実測18件)。
 */
describe("⑥自律判断はスタブを判断と見なさない", () => {
  async function judgeOf(db: D1Database, subject: string) {
    return db
      .prepare(`SELECT m2_exec, m6_judge, decision_kinds FROM autonomy_v1 WHERE subject = ?`)
      .bind(subject)
      .first<{ m2_exec: number | null; m6_judge: number | null; decision_kinds: number }>();
  }

  it("証跡が未移植マーカーだけの実体は m6_judge=0 になる", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/stub_job";
    await addSchedule(db, job, "0 0 * * *", "daily", null, 28);
    for (let d = 1; d <= 3; d++) {
      await event(db, { agent_id: job, daysAgo: d, action: "porting-pending", result: "skip", severity: "WARN" });
    }
    // 毎回同じ porting-pending を返すだけなので判断ではない
    expect(await judgeOf(db, job)).toMatchObject({ m2_exec: 0, m6_judge: 0, decision_kinds: 0 });
  });

  it("未移植マーカー以外の skip(条件を見て自分で見送った)は従来どおり数える", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/skipper_job";
    await addSchedule(db, job, "0 0 * * *", "daily", null, 28);
    await event(db, { agent_id: job, daysAgo: 1, action: "run", result: "skip" });
    // 実行すべきでないと自分で判断した skip は⑥の対象
    expect(await judgeOf(db, job)).toMatchObject({ m6_judge: 1, decision_kinds: 1 });
  });

  it("異常検知(deadline-approaching 等)は従来どおり数える", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/watcher_job";
    await addSchedule(db, job, "0 0 * * *", "daily", null, 28);
    await event(db, { agent_id: job, daysAgo: 1, action: "deadline-approaching", severity: "WARN" });
    await event(db, { agent_id: job, daysAgo: 2, action: "deadline-overdue", severity: "WARN" });
    expect(await judgeOf(db, job)).toMatchObject({ m6_judge: 2, decision_kinds: 2 });
  });

  it("実行が全部失敗していても異常検知をしていれば m2_exec=0 かつ m6_judge>0 は正当", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/failing_watcher";
    await addSchedule(db, job, "0 0 * * *", "daily", null, 28);
    for (let d = 1; d <= 3; d++) {
      await event(db, { agent_id: job, daysAgo: d, action: "run", result: "failure", severity: "CRITICAL" });
    }
    await event(db, { agent_id: job, daysAgo: 1, action: "deadline-overdue", severity: "WARN" });

    // この組み合わせを「矛盾」として一律に禁止してはいけない。
    // 実行に失敗し続けているジョブが期限超過を正しく検知することはあり得る。
    const r = await judgeOf(db, job);
    expect(r?.m2_exec).toBe(0);
    expect(r?.m6_judge).toBe(1);
  });
});

/**
 * 実体判定ガード(meta.expectation)の結果を計測に取り込む(0012)。
 * 「業務をせず、やり方の解説文を生成しただけ」の success を①②③⑤の分子から外す。
 * 未判定(expectation キーが無い)は従来どおり数える = ガードが opt-in 設計のため、
 * 「検査していない」と「検査して実体が無かった」を混同しない。
 */
describe("実体なしと判定された証跡の扱い", () => {
  const OK_FALSE = '{"expectation":{"expect":"external_data","ok":false,"reason":"no_verifiable_facts"}}';
  const OK_TRUE = '{"expectation":{"expect":"external_data","ok":true}}';

  async function row(db: D1Database, subject: string) {
    return db
      .prepare(
        `SELECT m1_report, m2_exec, m4_trace, success_days, exec_days, events_total,
                traceable_total, unsubstantiated_total
           FROM autonomy_v1 WHERE subject = ?`,
      )
      .bind(subject)
      .first<Record<string, number | null>>();
  }

  it("ok=false の success は①②③⑤の分子に入らない", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/explainer_job";
    await addSchedule(db, job, "0 0 * * *", "daily", null, 28);
    await mapMetric(db, job, "report");
    for (let d = 1; d <= 10; d++) {
      await event(db, { agent_id: job, daysAgo: d, meta: OK_FALSE });
    }
    const r = await row(db, job);
    // 10日ぶん success を出しているが、いずれも実体なしなので稼働日数は 0
    expect(r).toMatchObject({ success_days: 0, exec_days: 0, m1_report: 0, m2_exec: 0 });
  });

  it("同じイベントでも events_total と④証跡記録には数える", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/explainer_job2";
    await addSchedule(db, job, "0 0 * * *", "daily", null, 28);
    for (let d = 1; d <= 10; d++) {
      await event(db, { agent_id: job, daysAgo: d, meta: OK_FALSE });
    }
    const r = await row(db, job);
    // 実体は無くても「証跡としてきちんと記録された」ことは事実なので④は満点のまま
    expect(r).toMatchObject({ events_total: 10, traceable_total: 10, m4_trace: 5 });
  });

  it("expectation キーが無い従来のイベントは従来どおり数える(後方互換)", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/legacy_job";
    await addSchedule(db, job, "0 0 * * *", "daily", null, 28);
    for (let d = 1; d <= 28; d++) {
      await event(db, { agent_id: job, daysAgo: d, meta: '{"elapsed_ms":10}' });
    }
    const r = await row(db, job);
    expect(r).toMatchObject({ success_days: 28, m2_exec: 5, unsubstantiated_total: 0 });
  });

  it("ok=true は正常に数える(効きすぎていないことの確認)", async () => {
    const db = createFakeD1();
    const job = "tagtech-automation/real_job";
    await addSchedule(db, job, "0 0 * * *", "daily", null, 28);
    for (let d = 1; d <= 28; d++) {
      await event(db, { agent_id: job, daysAgo: d, meta: OK_TRUE });
    }
    const r = await row(db, job);
    expect(r).toMatchObject({ success_days: 28, m2_exec: 5, unsubstantiated_total: 0 });
  });

  it("除外件数が実体単位と組織サマリで一致する(静かに除外しない)", async () => {
    const db = createFakeD1();
    const a = "tagtech-automation/explainer_a";
    const b = "tagtech-automation/explainer_b";
    await addSchedule(db, a, "0 0 * * *", "daily", null, 28);
    await addSchedule(db, b, "0 0 * * *", "daily", null, 28);
    for (let d = 1; d <= 3; d++) await event(db, { agent_id: a, daysAgo: d, meta: OK_FALSE });
    for (let d = 1; d <= 2; d++) await event(db, { agent_id: b, daysAgo: d, meta: OK_FALSE });
    await event(db, { agent_id: b, daysAgo: 4, meta: OK_TRUE });

    expect((await row(db, a))?.unsubstantiated_total).toBe(3);
    expect((await row(db, b))?.unsubstantiated_total).toBe(2);

    const s = await db
      .prepare(`SELECT events_unsubstantiated, subjects_with_unsubstantiated FROM autonomy_org_summary`)
      .first<{ events_unsubstantiated: number; subjects_with_unsubstantiated: number }>();
    expect(s).toMatchObject({ events_unsubstantiated: 5, subjects_with_unsubstantiated: 2 });
  });
});

/**
 * 0013 で tagtech-cron の20ジョブを分類表に追加した。
 * それまで tagtech-cron の23実体は①③⑤が全件 NULL(測定対象外)で、
 * 「役割はあるが何も出していない」という事実が数値に現れていなかった。
 */
describe("tagtech-cron の分類(0013)", () => {
  it("分類を入れた実体は①③⑤が測定対象になる", async () => {
    const db = createFakeD1();
    const r = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM autonomy_metric_map WHERE job_id LIKE 'tagtech-cron/%') AS cron_mapped,
           (SELECT COUNT(*) FROM autonomy_metric_map) AS total_mapped`,
      )
      .first<{ cron_mapped: number; total_mapped: number }>();
    // 既存38(tagtech-automation) + 追加20(tagtech-cron)
    expect(r).toMatchObject({ cron_mapped: 20, total_mapped: 58 });
  });

  it("意図的に未分類の3件は①③⑤が NULL のまま", async () => {
    const db = createFakeD1();
    for (const job of ["tagtech-cron/funding-reminder", "tagtech-cron/heartbeat", "tagtech-cron/digest-watch"]) {
      await event(db, { agent_id: job, daysAgo: 1, meta: "{}" });
      const r = await db
        .prepare(`SELECT m1_report, m3_intake, m5_improve, m2_exec FROM autonomy_v1 WHERE subject = ?`)
        .bind(job)
        .first<Record<string, number | null>>();
      // 監視系は成果物(報告・収集・改善)を出さないので①③⑤では測らない。②は測れる。
      expect(r?.m1_report, job).toBeNull();
      expect(r?.m3_intake, job).toBeNull();
      expect(r?.m5_improve, job).toBeNull();
      expect(r?.m2_exec, job).not.toBeNull();
    }
  });

  it("分類を足しても②タスク実行の算出は変わらない(②は分類に依存しない)", async () => {
    const db = createFakeD1();
    // 0013 で report に分類済みで、かつ 0014 の job_schedule にも残っている日次ジョブ。
    // 旧 daily-standup は automation と重複していたため cron から降格され 0014 で schedule から消えた。
    const job = "tagtech-cron/pipeline-daily";
    for (let d = 1; d <= 28; d++) await event(db, { agent_id: job, daysAgo: d, meta: "{}" });
    const r = await db
      .prepare(`SELECT m1_report, m2_exec, expected_days FROM autonomy_v1 WHERE subject = ?`)
      .bind(job)
      .first<Record<string, number | null>>();
    // 分類により①が測れるようになるが、②は従来どおり cron を持つ全実体に適用される
    expect(r).toMatchObject({ expected_days: 28, m1_report: 5, m2_exec: 5 });
  });
});

describe("autonomy_org_summary (未測定を平均から除外する)", () => {
  it("実体なし54役職は平均に含めない", async () => {
    const db = createFakeD1();
    // 窓を固定する。roles_measured は seed のスケジュールから決まる値なので、
    // live 窓のままでは実時間でスライドして期限切れする(実際に 2026-09-17 JST に
    // 15 -> 14 になって CI が赤になった)。
    //
    // JST 2026-09-01〜09-28 を選ぶ理由:
    //   - dom=1 を含む  … cfo_monthly_report / monthly_fixed_expenses (CFO)
    //   - dom=20 を含む … cpo_platform_review (CPO の唯一の実体。これが窓外に
    //                      出ると CPO が未測定になり roles_measured が 1 減る)
    //   - 開始月と終了月が同じ 9 月 … job_expected の cand_a/cand_b が一致し、
    //                      月初をまたぐときの二重計上が起きない
    // weekly/daily/hourly は job_expected が expected_days_28d を素通しするので
    // 窓に影響されない。窓の選定で気にするのは monthly の dom だけでよい。
    await setWindow(db, jstDayStartUtc("2026-09-01"), jstDayStartUtc("2026-09-29"));
    const s = await pinnedOrgSummary(db);
    // seed の実データ。agent_ledger_current は最新 batch を指すので、batch が進むとここも動く。
    //   batch 2026-09-14 (0005): 69名中15名に実行実体あり(実体なし54)
    //   batch 2026-09-21 (0015): 69名中13名に実行実体あり(実体なし56)
    //     ← ciso_security_scan 停止 / google_calendar_sync・cio_daily_news 降格で CISO・CAO の実体が消えた
    // 基準線(15/54)と比較するときは batch_id を併記する(RUNBOOK §6-4)。
    expect(s).toMatchObject({
      roles_registered: 69,
      roles_with_entity: 13,
      roles_without_entity: 56,
      roles_measured: 13, // 56件は NULL なので平均の母数に入らない
    });
  });

  it("窓を固定せずに seed 由来の集計値を読もうとすると落ちる(再発防止)", async () => {
    const db = createFakeD1();
    // setWindow を呼ばないので window_source は live のまま。
    // このガードが無いと、窓のスライドで期限切れする固定値比較を書けてしまう。
    await expect(pinnedOrgSummary(db)).rejects.toThrow(/setWindow/);
  });

  it("スケジュール不明の実体は稼働率が未測定でも証跡の質は測る", async () => {
    const db = createFakeD1();
    const job = "notify-gw/selftest"; // job_schedule に無い(イベント駆動)
    for (let d = 1; d <= 3; d++) {
      await insertEvent(db, {
        ts: jstDaysAgoIso(d),
        agent_id: job,
        action: "run",
        result: "success",
        severity: "INFO",
        fingerprint: `fp-selftest-${d}`,
        meta: "{}",
      });
    }
    const r = await db
      .prepare(`SELECT expected_days, expected_basis, m2_exec, m4_trace, events_total FROM autonomy_v1 WHERE subject = ?`)
      .bind(job)
      .first<Record<string, number | string | null>>();
    expect(r).toMatchObject({ expected_days: null, expected_basis: "unknown", m2_exec: null, m4_trace: 5, events_total: 3 });
  });
});
