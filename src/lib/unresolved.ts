/**
 * 未解消 CRITICAL の持ち越し。
 *
 * 2026-09-15 から3日間、tagtech-automation の Deploy が失敗し続けた。
 * 証跡層は正しく働いていた — CRITICAL として記録し、#alerts にも送り、
 * 日報の「失敗・CRITICAL」欄にも出していた。**それでも誰も気づかなかった。**
 *
 * 原因は仕組みではなく、「日報の CRITICAL 欄を毎朝見る」という運用が
 * 人の注意力に依存していたこと。1日分の日報は翌日には流れてしまい、
 * 見逃した異常は二度と目に入らない。
 *
 * そこで **解消されていない異常は、解消されるまで毎日繰り返し報告する。**
 * 解消の判定は「同じ agent_id + action で success が記録されたか」だけで行い、
 * 人の「確認済み」操作は設けない（人の操作に依存すると、それ自体が忘れられる）。
 *
 * このモジュールは LLM を使わない。渡された値を並べるだけで、解釈も言い換えもしない。
 */

export interface UnresolvedCritical {
  agent_id: string;
  action: string;
  /** 最初に落ちたときの target/action。表示用 */
  summary: string;
  /** 最初の CRITICAL の証跡ID。追跡の起点になるので最新ではなく最古を持つ */
  first_id: number;
  /** 最初に落ちた時刻(ISO8601 UTC) */
  first_ts: string;
  /** 畳んだ件数。同じジョブが3日失敗し続ければ 3 */
  count: number;
  /**
   * このうち #alerts 送信に失敗した件数(discord_sent=0)。持ち越しの解消条件(agent_id+action の
   * success)にそのまま乗せる(2026-09-22 社長指示)。新しい解消条件は作らない — 送信失敗も
   * 結局は元の異常が解消されれば持ち越しから消えるので、既存の判定をそのまま使えば足りる。
   * 死活異常(binding drift)にはこの概念が無いので省略可(undefined→0扱い)。
   */
  alert_failed?: number;
}

/** 日報本体を押し出さないよう、一覧は上位5件まで */
const KEEP = 5;

/**
 * 死活異常（バインディング申告の途絶・欠落）を持ち越しの形に変換する。
 *
 * 2026-09-15 から tagtech-cron の申告が途絶し、日報の「死活・バインディング異常」欄に
 * 出続けていたが2日間気づかれなかった。**解消されるまで続く異常**という点で
 * CRITICAL と同じ性質なので、別枠にせず同じ一覧に混ぜる。
 *
 * 経過日数の基準は「最後に申告が届いた時刻」。一度も届いていなければ
 * 起点が無いので、呼び出し側が渡す asOf を使う（0日＝本日として出る）。
 */
export function driftsToUnresolved(
  drifts: Array<{
    agent_id: string;
    missing: string[];
    reported_at: string | null;
    stale: boolean;
    neverReported: boolean;
  }>,
  asOfIso: string,
): UnresolvedCritical[] {
  return drifts.map((d) => {
    const summary = d.neverReported
      ? "一度も申告が届いていない(未配線の可能性)"
      : d.missing.length > 0
        ? `期待バインディング欠落: ${d.missing.join(", ")}`
        : `申告途絶(最終 ${d.reported_at})`;
    return {
      agent_id: d.agent_id,
      action: d.missing.length > 0 ? "binding-drift" : "binding-report-stale",
      summary,
      // 証跡ID は持たない。0 を入れて「e-0」と出すと嘘になるので -1 で表し、表示側で省く
      first_id: -1,
      first_ts: d.reported_at ?? asOfIso,
      count: 1,
    };
  });
}

function daysAgo(fromIso: string, nowMs: number): number {
  const diff = nowMs - Date.parse(fromIso);
  return Math.floor(diff / (24 * 3600 * 1000));
}

function ageLabel(fromIso: string, nowMs: number): string {
  const d = daysAgo(fromIso, nowMs);
  return d <= 0 ? "本日" : `${d}日前`;
}

/**
 * 日報の先頭（実行件数の前）に置く行を返す。0件なら空配列。
 * 平常時に行を増やさないことで、出ていること自体が異常のサインになる。
 */
export function buildUnresolvedSection(rows: UnresolvedCritical[], nowMs: number): string[] {
  if (rows.length === 0) return [];

  // 放置が長いものほど上。古い順に並べる
  const sorted = [...rows].sort((a, b) => Date.parse(a.first_ts) - Date.parse(b.first_ts));
  const oldest = sorted[0];

  const lines: string[] = [
    `── 未解消 CRITICAL: ${sorted.length}件 (最古: ${ageLabel(oldest.first_ts, nowMs)}) ──`,
  ];

  for (const r of sorted.slice(0, KEEP)) {
    const d = daysAgo(r.first_ts, nowMs);
    const age = d <= 0 ? "本日" : `${d}日`;
    const countSuffix = r.count > 1 ? ` ×${r.count}回` : "";
    // 死活異常は証跡IDを持たない(first_id = -1)。「e-0」のような嘘のIDを出さない
    const idPart = r.first_id >= 0 ? `証跡ID: e-${r.first_id}${countSuffix}, ` : "";
    const alertNote = (r.alert_failed ?? 0) > 0 ? " ⚠#alerts未達" : "";
    lines.push(`  ${r.agent_id} ${r.action}: ${r.summary} (${idPart}${age})${alertNote}`);
  }

  const omitted = sorted.length - Math.min(sorted.length, KEEP);
  if (omitted > 0) lines.push(`  他${omitted}件`);

  return lines;
}
