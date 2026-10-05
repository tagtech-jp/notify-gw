/**
 * 速い死活監視(2026-10-05 社長指示「notify-gw 本体の変更を今すぐ自動でして」)。
 *
 * 既定の申告途絶の判定(auditBindings)は「26時間・日報を作るときだけ」で、気づくまで最大約50時間かかり、
 * #alerts は鳴らない。日次 cron の Worker にはそれで足りるが、1時間ごとに申告する PC の常駐(fuwacchi-feed)には遅い。
 * PC が止まる・常駐が落ちる・ネットが切れると配信を収録できないのに、PC の中からはそれに気づけない(沈黙は異常)。
 *
 * - 対象としきい値は vars の FAST_LIVENESS(「agent_id:分」をカンマ区切り)。見張る相手そのものは
 *   expected_bindings が唯一の真実源で、ここは「どれだけ速く知らせるか」だけを持つ
 * - 15分ごとの cron で、最後の申告からしきい値を超えた相手を CRITICAL で #alerts に知らせる(1回の途絶につき1回だけ)
 * - 一度も申告が無い(未配線)ものは知らせない(日報の1行に留める既存の方針と同じ)
 * - 申告が戻ったら同じ agent_id + action の success を記録する。日報の未解消一覧から機械的に消える(人の確認操作は設けない)
 *
 * このモジュールは判定だけを持ち、証跡の記録と #alerts への送信は index.ts の recordAndAlert が行う。
 */

export const LIVENESS_ACTION = "liveness-stale";
/**
 * 判定が動いた証拠(1日1件)の agent_id。tagtech-cron と同じ「Worker名/ジョブ名」にする。
 * "notify-gw" で残すと、自律度の計測(events.agent_id = job_id)で日報が失敗した日も notify-gw の成功日に数えてしまう
 */
export const LIVENESS_CHECK_AGENT = "notify-gw/liveness";

/** 「agent_id:分」をカンマ区切りで読む。壊れた項目は捨てる(監視を止めないため、例外にしない) */
export function parseFastLiveness(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (raw ?? "").split(",")) {
    const m = part.trim().match(/^([^:\s]+)\s*:\s*(\d+)$/);
    if (!m) continue;
    const minutes = Number(m[2]);
    if (minutes > 0) out.set(m[1], minutes);
  }
  return out;
}

export interface StaleTarget {
  agent_id: string;
  reported_at: string;
  threshold_min: number;
  elapsed_min: number;
}

/**
 * しきい値を超えて申告が途絶え、まだ今回の途絶を知らせていない相手。
 * 「今回の途絶を知らせたか」は、最後の申告より後に同じ相手の liveness-stale の CRITICAL があるかで見る。
 */
export async function findNewlyStale(db: D1Database, targets: Map<string, number>, nowMs: number): Promise<StaleTarget[]> {
  if (targets.size === 0) return [];
  const res = await db
    .prepare(
      `SELECT e.agent_id, r.reported_at
       FROM expected_bindings e
       LEFT JOIN binding_reports r ON r.agent_id = e.agent_id
       ORDER BY e.agent_id`,
    )
    .all<{ agent_id: string; reported_at: string | null }>();

  const out: StaleTarget[] = [];
  for (const row of res.results ?? []) {
    const thresholdMin = targets.get(row.agent_id);
    if (thresholdMin === undefined || row.reported_at === null) continue; // 対象外・未配線
    const elapsedMin = Math.floor((nowMs - Date.parse(row.reported_at)) / 60000);
    if (elapsedMin <= thresholdMin) continue;
    const alerted = await db
      .prepare(
        `SELECT 1 AS hit FROM events
         WHERE agent_id = ? AND action = ? AND severity = 'CRITICAL' AND ts > ?
         LIMIT 1`,
      )
      .bind(row.agent_id, LIVENESS_ACTION, row.reported_at)
      .first<{ hit: number }>();
    if (alerted) continue;
    out.push({ agent_id: row.agent_id, reported_at: row.reported_at, threshold_min: thresholdMin, elapsed_min: elapsedMin });
  }
  return out;
}

/**
 * 解消していない liveness-stale の CRITICAL(同じ agent_id + action の success がまだ無いもの)の最新の時刻。
 * 無ければ null。申告が戻ったときに success を記録するかの判定に使う。
 */
export async function openLivenessAlert(db: D1Database, agentId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT c.ts FROM events c
       WHERE c.agent_id = ? AND c.action = ? AND c.severity = 'CRITICAL'
         AND NOT EXISTS (
           SELECT 1 FROM events s
           WHERE s.agent_id = c.agent_id AND s.action = c.action AND s.result = 'success' AND s.ts > c.ts
         )
       ORDER BY c.ts DESC LIMIT 1`,
    )
    .bind(agentId, LIVENESS_ACTION)
    .first<{ ts: string }>();
  return row?.ts ?? null;
}

/** 判定が動いた証拠を1日1件だけ残すか(その日まだ liveness-check の記録が無ければ true) */
export async function shouldRecordDailyCheck(db: D1Database, dayStartUtc: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM events WHERE agent_id = ? AND action = 'liveness-check' AND ts >= ? LIMIT 1`)
    .bind(LIVENESS_CHECK_AGENT, dayStartUtc)
    .first<{ hit: number }>();
  return !row;
}

/** 日本時間の「MM/DD HH:MM」。通知の本文用 */
export function jstLabel(iso: string, tzOffsetHours: number): string {
  const d = new Date(Date.parse(iso) + tzOffsetHours * 3600 * 1000);
  return d.toISOString().slice(5, 16).replace("-", "/").replace("T", " ");
}

export function minutesLabel(min: number): string {
  return min >= 60 ? `${Math.floor(min / 60)}時間${min % 60}分` : `${min}分`;
}
