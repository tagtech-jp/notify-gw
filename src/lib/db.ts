export interface EventInput {
  ts: string;
  agent_id: string;
  action: string;
  target?: string;
  result: "success" | "failure" | "skip";
  severity: "CRITICAL" | "WARN" | "INFO";
  evidence_url?: string;
  fingerprint: string;
  meta?: string; // JSON文字列
}

export async function insertEvent(db: D1Database, ev: EventInput): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO events (ts, agent_id, action, target, result, severity, evidence_url, fingerprint, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ev.ts,
      ev.agent_id,
      ev.action,
      ev.target ?? null,
      ev.result,
      ev.severity,
      ev.evidence_url ?? null,
      ev.fingerprint,
      ev.meta ?? null,
    )
    .run();
  return Number(res.meta.last_row_id);
}

export async function countRecentCriticalByFingerprint(
  db: D1Database,
  fingerprint: string,
  sinceIso: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM events WHERE fingerprint = ? AND ts >= ? AND severity = 'CRITICAL'`,
    )
    .bind(fingerprint, sinceIso)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

export async function getLastEventTs(db: D1Database): Promise<string | null> {
  const row = await db.prepare(`SELECT ts FROM events ORDER BY id DESC LIMIT 1`).first<{ ts: string }>();
  return row?.ts ?? null;
}

/**
 * CRITICAL の #alerts 送信結果を、対象イベント行に書き足す(migration 0016)。
 * events は追記専用が原則だが、送信結果は insertEvent の時点でまだ判明していない
 * (Discord へ送るには先に events の id が要る)ため、送信後の1回だけ例外的に UPDATE する。
 *
 * 列が無い(migration未適用)場合や書き込みが失敗しても、ここで throw しない。
 * 証跡本体(events の INSERT)は既に成功しているので、送信結果の記録だけを諦める
 * (社長指示 2026-09-22: 列が無い/書き込み失敗でも events 本体の書き込みは失敗させない)。
 */
export async function markDiscordResult(
  db: D1Database,
  eventId: number,
  sent: boolean,
  status: number | null,
): Promise<void> {
  try {
    await db
      .prepare(`UPDATE events SET discord_sent = ?, discord_status = ? WHERE id = ?`)
      .bind(sent ? 1 : 0, status, eventId)
      .run();
  } catch {
    // 意図的に握りつぶす。理由は上記コメント参照
  }
}

export interface FailureRow {
  id: number;
  agent_id: string;
  action: string;
  summary: string;
  count: number;
}

export interface AgentRow {
  agent_id: string;
  total: number;
  success: number;
  failure: number;
  skip: number;
}

export interface DayAggregate {
  total: number;
  success: number;
  failure: number;
  /** result=skip(未移植・注釈など)。total = success + failure + skip が成り立つ */
  skip: number;
  critical: number;
  /** CRITICAL のうち #alerts への送信に失敗した件数(discord_sent=0)。migration未適用時は0 */
  alertsFailed: number;
  failures: FailureRow[];
  /** severity=WARN かつ失敗ではない注意事項（期限接近など）。未移植は別集計 */
  warnings: FailureRow[];
  /** action='porting-pending' を出した agent_id の一覧（未移植ジョブ） */
  portingPending: string[];
  /**
   * success と申告されたが、期待した実体が確認できなかったもの。
   * 「業務をしていないのに成功と記録される」状態を ✅ から分けて報告するために使う。
   */
  unsubstantiated: UnsubstantiatedRow[];
  byAgent: AgentRow[];
}

/** 実体判定に落ちた1件（meta.expectation の verdict 由来） */
export interface UnsubstantiatedRow {
  agent_id: string;
  action: string;
  reason: string;
  count: number;
}

/** 未移植ジョブを表す action。送信元(tagtech-cron)と合わせること */
export const PORTING_PENDING_ACTION = "porting-pending";

export async function listPortingPending(db: D1Database, startUtc: string, endUtc: string): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT DISTINCT agent_id FROM events
       WHERE ts >= ? AND ts < ? AND action = ?
       ORDER BY agent_id`,
    )
    .bind(startUtc, endUtc, PORTING_PENDING_ACTION)
    .all<{ agent_id: string }>();
  return (res.results ?? []).map((r) => r.agent_id);
}

/**
 * 実体判定(meta.expectation)に落ちた行を集計する。
 * result は送信側の申告のまま残してあるので、ここで ✅ から切り分ける。
 * 判定そのものは受信時に済んでおり、ここは JSON を読むだけ(LLM 不使用)。
 */
export async function listUnsubstantiated(
  db: D1Database,
  startUtc: string,
  endUtc: string,
): Promise<UnsubstantiatedRow[]> {
  const res = await db
    .prepare(
      `SELECT agent_id, action,
              COALESCE(json_extract(meta, '$.expectation.reason'), 'unknown') as reason,
              COUNT(*) as count
       FROM events
       WHERE ts >= ? AND ts < ?
         AND json_extract(meta, '$.expectation.ok') = 0
       GROUP BY agent_id, action, reason
       ORDER BY count DESC, agent_id`,
    )
    .bind(startUtc, endUtc)
    .all<UnsubstantiatedRow>();
  return res.results ?? [];
}

/**
 * 未解消の CRITICAL を返す。
 *
 * 「解消」= その CRITICAL より後に、同じ agent_id + action で result='success' が
 * 1件でも記録されたこと。人の「確認済み」操作は設けない
 * (人の操作に依存すると、それ自体が忘れられる)。
 *
 * 集計期間には縛られない。日報は前日1日分を集計するが、**持ち越しは期間の外まで遡る**。
 * 2026-09-15 の Deploy 失敗が3日間気づかれなかったのは、1日分の日報しか見えず
 * 翌日には流れてしまったため。
 *
 * agent_id + action 単位で畳み、最古の1件を代表として持つ(追跡の起点になるので
 * 最新ではなく最古)。
 */
export async function listUnresolvedCriticals(
  db: D1Database,
  asOfUtc: string,
  lookbackDays = 30,
): Promise<UnresolvedCriticalRow[]> {
  const sinceIso = new Date(Date.parse(asOfUtc) - lookbackDays * 24 * 3600 * 1000).toISOString();
  const res = await db
    .prepare(
      `SELECT c.agent_id, c.action,
              MIN(c.id)  AS first_id,
              MIN(c.ts)  AS first_ts,
              COUNT(*)   AS count,
              MIN(COALESCE(c.target, c.action)) AS summary,
              SUM(CASE WHEN c.discord_sent = 0 THEN 1 ELSE 0 END) AS alert_failed
       FROM events c
       WHERE c.severity = 'CRITICAL'
         AND c.ts >= ? AND c.ts < ?
         -- Phase1 の自己検証(e-2/e-3)は「CRITICAL 経路が動くか」を試した意図的な失敗で、
         -- 解消すべき異常ではない。success を後付けで書いて消すのは嘘の証跡になるので
         -- (社長判断 2026-09-20)、判定側で selftest だけを除外する。運用ジョブには一切効かない。
         AND c.agent_id NOT LIKE 'notify-gw/selftest%'
         AND NOT EXISTS (
           SELECT 1 FROM events s
           WHERE s.agent_id = c.agent_id
             AND s.action   = c.action
             AND s.result   = 'success'
             AND s.ts       > c.ts
         )
       GROUP BY c.agent_id, c.action
       ORDER BY first_ts ASC`,
    )
    .bind(sinceIso, asOfUtc)
    .all<UnresolvedCriticalRow>();
  return res.results ?? [];
}

export interface UnresolvedCriticalRow {
  agent_id: string;
  action: string;
  summary: string;
  first_id: number;
  first_ts: string;
  count: number;
  /** このうち #alerts 送信に失敗した件数(discord_sent=0)。migration未適用時はNULL→0扱い */
  alert_failed: number;
}

/** [startUtc, endUtc) の範囲でイベントをSQL集計する。数値・ID・agent_idはすべてDB由来。 */
export async function aggregateRange(db: D1Database, startUtc: string, endUtc: string): Promise<DayAggregate> {
  const totalsRow = await db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) as success,
         SUM(CASE WHEN result = 'failure' THEN 1 ELSE 0 END) as failure,
         SUM(CASE WHEN result = 'skip' THEN 1 ELSE 0 END) as skip,
         SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END) as critical,
         SUM(CASE WHEN severity = 'CRITICAL' AND discord_sent = 0 THEN 1 ELSE 0 END) as alerts_failed
       FROM events WHERE ts >= ? AND ts < ?`,
    )
    .bind(startUtc, endUtc)
    .first<{ total: number; success: number; failure: number; skip: number; critical: number; alerts_failed: number }>();

  const failuresResult = await db
    .prepare(
      `SELECT MIN(id) as id, agent_id, action, COUNT(*) as count,
              MIN(COALESCE(target, action)) as summary
       FROM events
       WHERE ts >= ? AND ts < ? AND (result = 'failure' OR severity = 'CRITICAL')
       GROUP BY fingerprint, agent_id, action
       ORDER BY count DESC, id ASC
       LIMIT 20`,
    )
    .bind(startUtc, endUtc)
    .all<FailureRow>();

  const warningsResult = await db
    .prepare(
      `SELECT MIN(id) as id, agent_id, action, COUNT(*) as count,
              MIN(COALESCE(target, action)) as summary
       FROM events
       WHERE ts >= ? AND ts < ? AND severity = 'WARN' AND result <> 'failure' AND action <> ?
       GROUP BY fingerprint, agent_id, action
       ORDER BY count DESC, id ASC
       LIMIT 20`,
    )
    .bind(startUtc, endUtc, PORTING_PENDING_ACTION)
    .all<FailureRow>();

  const portingPending = await listPortingPending(db, startUtc, endUtc);
  const unsubstantiated = await listUnsubstantiated(db, startUtc, endUtc);

  // 未移植ジョブは「未移植: N ジョブ」の1行に畳むので、エージェント別からは除く
  const byAgentResult = await db
    .prepare(
      `SELECT agent_id,
              COUNT(*) as total,
              SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) as success,
              SUM(CASE WHEN result = 'failure' THEN 1 ELSE 0 END) as failure,
              SUM(CASE WHEN result = 'skip' THEN 1 ELSE 0 END) as skip
       FROM events
       WHERE ts >= ? AND ts < ? AND action <> ?
       GROUP BY agent_id
       ORDER BY total DESC`,
    )
    .bind(startUtc, endUtc, PORTING_PENDING_ACTION)
    .all<AgentRow>();

  return {
    total: totalsRow?.total ?? 0,
    success: totalsRow?.success ?? 0,
    failure: totalsRow?.failure ?? 0,
    skip: totalsRow?.skip ?? 0,
    critical: totalsRow?.critical ?? 0,
    alertsFailed: totalsRow?.alerts_failed ?? 0,
    failures: failuresResult.results ?? [],
    warnings: warningsResult.results ?? [],
    portingPending,
    unsubstantiated,
    byAgent: byAgentResult.results ?? [],
  };
}

export async function upsertDigestLog(
  db: D1Database,
  args: { dateJst: string; sentAt: string; agg: DayAggregate; discordOk: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO digest_log (date_jst, sent_at, total, success, failure, critical, discord_ok)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date_jst) DO UPDATE SET
         sent_at = excluded.sent_at,
         total = excluded.total,
         success = excluded.success,
         failure = excluded.failure,
         critical = excluded.critical,
         discord_ok = excluded.discord_ok`,
    )
    .bind(
      args.dateJst,
      args.sentAt,
      args.agg.total,
      args.agg.success,
      args.agg.failure,
      args.agg.critical,
      args.discordOk ? 1 : 0,
    )
    .run();
}

export interface BindingDrift {
  agent_id: string;
  missing: string[];
  reported_at: string | null;
  stale: boolean;
  /** 一度も申告が届いていない = まだ配線されていない。障害(途絶)と区別する */
  neverReported: boolean;
}

/** 申告が無い/古いと判定する時間。日次 cron の Worker が 1 回飛ばしても誤検知しないよう 26 時間 */
export const REPORT_STALE_HOURS = 26;

export async function getExpectedBindings(db: D1Database, agentId: string): Promise<string[] | null> {
  const row = await db
    .prepare(`SELECT bindings FROM expected_bindings WHERE agent_id = ?`)
    .bind(agentId)
    .first<{ bindings: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.bindings) as string[];
  } catch {
    return null;
  }
}

/** どの変数に何のモデルが設定されているか。値だけだと直す場所が分からない */
export interface ReportedModel {
  var: string;
  model: string;
}

export async function upsertBindingReport(
  db: D1Database,
  args: {
    agentId: string;
    bindings: string[];
    missing: string[];
    reportedAt: string;
    versionHint?: string;
    /** 省略時は既存の申告を消さない(モデルを持たない送信元が NULL で上書きしないため) */
    models?: ReportedModel[];
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO binding_reports (agent_id, bindings, missing, reported_at, version_hint, models)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         bindings = excluded.bindings,
         missing = excluded.missing,
         reported_at = excluded.reported_at,
         version_hint = excluded.version_hint,
         -- models を送ってこなかった申告で既存の申告を消さない。
         -- WSL の常駐スクリプトのようにモデルを持たない送信元も同じ経路を使うため。
         models = COALESCE(excluded.models, binding_reports.models)`,
    )
    .bind(
      args.agentId,
      JSON.stringify(args.bindings),
      JSON.stringify(args.missing),
      args.reportedAt,
      args.versionHint ?? null,
      args.models === undefined ? null : JSON.stringify(args.models),
    )
    .run();
}

/** 各 Worker が申告したモデル一覧。cto-tech-monitor が照合に使う */
export interface AgentModels {
  agent_id: string;
  models: ReportedModel[];
  reported_at: string;
}

export async function listReportedModels(db: D1Database): Promise<AgentModels[]> {
  const res = await db
    .prepare(
      `SELECT agent_id, models, reported_at FROM binding_reports
       WHERE models IS NOT NULL ORDER BY agent_id`,
    )
    .all<{ agent_id: string; models: string; reported_at: string }>();

  const out: AgentModels[] = [];
  for (const row of res.results ?? []) {
    let models: ReportedModel[];
    try {
      const parsed = JSON.parse(row.models) as unknown;
      if (!Array.isArray(parsed)) continue;
      models = parsed.filter(
        (m): m is ReportedModel =>
          typeof m === "object" && m !== null &&
          typeof (m as ReportedModel).var === "string" &&
          typeof (m as ReportedModel).model === "string",
      );
    } catch {
      continue; // 壊れた申告は無視する。監視ジョブを落とさない
    }
    if (models.length > 0) out.push({ agent_id: row.agent_id, models, reported_at: row.reported_at });
  }
  return out;
}

/**
 * 期待値と最終申告を突き合わせ、ドリフト(欠落 or 申告途絶)を返す。
 * 期待値は expected_bindings が唯一の真実源で、ここ以外にハードコードしない。
 */
export async function auditBindings(db: D1Database, nowMs: number): Promise<BindingDrift[]> {
  const res = await db
    .prepare(
      `SELECT e.agent_id, e.bindings AS expected, r.missing, r.reported_at
       FROM expected_bindings e
       LEFT JOIN binding_reports r ON r.agent_id = e.agent_id
       ORDER BY e.agent_id`,
    )
    .all<{ agent_id: string; expected: string; missing: string | null; reported_at: string | null }>();

  const drifts: BindingDrift[] = [];
  for (const row of res.results ?? []) {
    const missing = row.missing ? (JSON.parse(row.missing) as string[]) : [];
    const neverReported = row.reported_at === null;
    const stale = neverReported || nowMs - Date.parse(row.reported_at!) > REPORT_STALE_HOURS * 3600 * 1000;
    if (missing.length > 0 || stale) {
      drifts.push({ agent_id: row.agent_id, missing, reported_at: row.reported_at, stale, neverReported });
    }
  }
  return drifts;
}

export async function getDigestLog(
  db: D1Database,
  dateJst: string,
): Promise<{ sent_at: string | null; discord_ok: number } | null> {
  return db
    .prepare(`SELECT sent_at, discord_ok FROM digest_log WHERE date_jst = ?`)
    .bind(dateJst)
    .first<{ sent_at: string | null; discord_ok: number }>();
}
