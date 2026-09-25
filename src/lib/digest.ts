/**
 * 真実日報 v1。LLM を一切使わない。
 * 数値・ID・agent_id はすべて呼び出し側(DB集計)から渡された値をそのまま埋め込むだけで、
 * このモジュールが文字列を「解釈」したり「言い換え」たりする経路は無い。
 */
import type { BindingDrift, DayAggregate, FailureRow, UnsubstantiatedRow } from "./db";
import type { TokenExpiry } from "./token_expiry";
import { buildUnresolvedSection, type UnresolvedCritical } from "./unresolved";

export interface DigestData extends DayAggregate {
  dateJst: string;
  /** 前日の未移植ジョブ一覧。渡されたときだけ増減を表示する */
  portingPendingPrev?: string[];
  /** 前日の実体判定落ち。渡されたときだけ増減を表示する（減少は改善の指標なので必ず見せる） */
  unsubstantiatedPrev?: UnsubstantiatedRow[];
  /** バインディングのドリフト(欠落・申告途絶)。日報作成時点の実測 */
  bindingDrifts?: BindingDrift[];
  /** 期限が近い/切れた credential。切れてから気づく事故を防ぐ */
  tokenExpiries?: TokenExpiry[];
  /**
   * 未解消の CRITICAL（集計期間の外まで遡る）。
   * 1日分の日報は翌日には流れるので、解消されるまで毎日先頭で繰り返す。
   */
  unresolvedCriticals?: UnresolvedCritical[];
  /** 経過日数の基準時刻。省略時は Date.now()。テストで固定するために受け取る */
  nowMs?: number;
}

const DISCORD_LIMIT = 2000;
const FOOTER = "※本日報は証跡DBのSQL集計のみで生成。生成LLM不使用。";

function formatRow(f: FailureRow): string {
  const countSuffix = f.count > 1 ? ` ×${f.count}回` : "";
  return `${f.agent_id} ${f.action}: ${f.summary} (証跡ID: e-${f.id}${countSuffix})`;
}

function pushRows(lines: string[], rows: FailureRow[], keep: number): void {
  const shown = rows.slice(0, keep);
  for (const r of shown) lines.push(formatRow(r));
  const omitted = rows.length - shown.length;
  if (omitted > 0) lines.push(`他${omitted}件`);
}

/** 「未移植: N ジョブ」。前日と差があるときだけ増減の詳細を付ける */
function portingLine(current: string[], prev: string[] | undefined): string | null {
  if (current.length === 0 && (!prev || prev.length === 0)) return null;
  let line = `未移植: ${current.length} ジョブ`;
  if (prev !== undefined) {
    const prevSet = new Set(prev);
    const curSet = new Set(current);
    const added = current.filter((a) => !prevSet.has(a));
    const resolved = prev.filter((a) => !curSet.has(a));
    if (added.length > 0 || resolved.length > 0) {
      const parts = [`前日 ${prev.length}`];
      if (added.length > 0) parts.push(`追加: ${added.join(", ")}`);
      if (resolved.length > 0) parts.push(`解消: ${resolved.join(", ")}`);
      line += ` (${parts.join(" / ")})`;
    }
  }
  return line;
}

/** 理由の大分類。「設計上の誤り」と「実体なし」は原因が違うので分けて数える */
function isDesignError(reason: string): boolean {
  return reason === "deterministic_via_llm";
}

/**
 * **タスク数**を数える。イベント数（count の合計）ではない。
 *
 * 同じタスクが1日に何度も落ちるとイベント数は膨らむが、直すべき対象の数は変わらない。
 * 「設計上の誤り 46件」と出ていたのは 23 タスク × 2 回のイベント数だった。
 * 1行 = 1タスク（agent_id + action + reason で GROUP BY 済み）なので行数を返す。
 */
export function taskCount(rows: UnsubstantiatedRow[]): number {
  return rows.length;
}

/** 前日比。減った分は進捗なので必ず見せる */
function deltaSuffix(current: UnsubstantiatedRow[], prev: UnsubstantiatedRow[] | undefined): string {
  if (prev === undefined) return "";
  const cur = taskCount(current);
  const before = taskCount(prev);
  if (cur === before) return "";
  const diff = cur - before;
  const arrow = diff > 0 ? `+${diff}` : `${diff}`;
  // 解消したジョブ名は改善の証拠なので列挙する(増えた側は Vault の全一覧で追える)
  const curKeys = new Set(current.map((r) => `${r.agent_id}|${r.action}`));
  const resolved = prev.filter((r) => !curKeys.has(`${r.agent_id}|${r.action}`)).map((r) => r.agent_id);
  const parts = [`前日 ${before} → ${cur} (${arrow})`];
  if (resolved.length > 0) parts.push(`解消: ${resolved.join(", ")}`);
  return ` (${parts.join(" / ")})`;
}

/**
 * 「設計上の誤り」「実体なし」をそれぞれ1行に畳む。
 * 21 行並べると日報を1通に圧縮した意味が失われるため、全一覧は Vault 側に置く。
 */
function substantiationLines(
  current: UnsubstantiatedRow[],
  prev: UnsubstantiatedRow[] | undefined,
): string[] {
  const out: string[] = [];
  const groups: Array<[string, (r: UnsubstantiatedRow) => boolean]> = [
    ["設計上の誤り", (r) => isDesignError(r.reason)],
    ["実体なし", (r) => !isDesignError(r.reason)],
  ];
  for (const [label, pred] of groups) {
    const cur = current.filter(pred);
    const pv = prev?.filter(pred);
    if (cur.length === 0 && (!pv || pv.length === 0)) continue;
    out.push(`${label}: ${taskCount(cur)} 件${deltaSuffix(cur, pv)} (詳細は Vault の日次サマリ)`);
  }
  return out;
}

function render(data: DigestData, failureKeep: number, warningKeep: number, agentKeep: number): string {
  const lines: string[] = [];
  lines.push(`📊 TagTech 日報 | ${data.dateJst} (JST)`);

  // 未解消の異常は実行件数より前に出す。日報を開いて最初に目に入る位置に置くことで、
  // 「毎朝 CRITICAL 欄を見る」という人の注意力への依存を外す。
  // 0件なら1行も出さないので、出ていること自体が異常のサインになる。
  lines.push(...buildUnresolvedSection(data.unresolvedCriticals ?? [], data.nowMs ?? Date.now()));

  // 合計 = ✅ + ❌ + ⏭ が一目で検算できるようにする(🔴 は ❌ の内数)
  // 実体判定に落ちた件数は ✅ の内数。成功件数だけを見て「動いている」と誤読させない
  const unsub = data.unsubstantiated ?? [];
  const unsubTotal = taskCount(unsub);
  const successNote = unsubTotal > 0 ? `✅ ${data.success}(うち実体なし ${unsubTotal})` : `✅ ${data.success}`;
  lines.push(
    `実行: ${data.total} 件 | ${successNote} | ❌ ${data.failure} | ⏭ ${data.skip} | 🔴 CRITICAL ${data.critical}`,
  );

  // CRITICAL は記録されたが #alerts に届かなかった件数。0件なら1行も出さない
  // (未解消CRITICALと同じ「出ていること自体が異常のサイン」の設計)。
  const alertsFailed = data.alertsFailed ?? 0;
  if (alertsFailed > 0) {
    lines.push(`── #alerts送信失敗: ${alertsFailed}件 ──`);
  }

  lines.push(`── 失敗・CRITICAL ──`);
  if (data.failures.length === 0) {
    lines.push(`(失敗・CRITICALなし)`);
  } else {
    pushRows(lines, data.failures, failureKeep);
  }

  if (data.warnings.length > 0) {
    lines.push(`── 注意(WARN) ──`);
    pushRows(lines, data.warnings, warningKeep);
  }

  const porting = portingLine(data.portingPending, data.portingPendingPrev);
  if (porting) lines.push(porting);

  // 日報は1通に圧縮するのが目的なので、ここは件数の1行だけ。全一覧は Vault の日次サマリに出す。
  for (const line of substantiationLines(unsub, data.unsubstantiatedPrev)) lines.push(line);

  const drifts = data.bindingDrifts ?? [];
  if (drifts.length > 0) {
    lines.push(`── 死活・バインディング異常 ──`);
    for (const d of drifts) {
      const reasons: string[] = [];
      if (d.missing.length > 0) reasons.push(`欠落: ${d.missing.join(", ")}`);
      // 一度も届いていない(未配線)と、届いていたのに途絶えた(障害)を区別する
      if (d.neverReported) reasons.push("申告なし(未配線)");
      else if (d.stale) reasons.push(`申告途絶(最終 ${d.reported_at})`);
      lines.push(`${d.agent_id}: ${reasons.join(" / ")}`);
    }
  }

  const expiries = data.tokenExpiries ?? [];
  if (expiries.length > 0) {
    lines.push(`── 期限切れ間近 ──`);
    for (const t of expiries) {
      lines.push(
        t.expired
          ? `${t.name}: 期限切れ (${t.expiresOn}・${-t.daysLeft}日超過)`
          : `${t.name}: 残り ${t.daysLeft} 日 (${t.expiresOn})`,
      );
    }
  }

  lines.push(`── エージェント別 ──`);
  const shownAgents = data.byAgent.slice(0, agentKeep);
  for (const a of shownAgents) {
    lines.push(`${a.agent_id}: ${a.total}件 (✅${a.success}/❌${a.failure}/⏭${a.skip})`);
  }
  const omittedAgents = data.byAgent.length - shownAgents.length;
  if (omittedAgents > 0) lines.push(`他${omittedAgents}件`);

  lines.push(FOOTER);
  return lines.join("\n");
}

/**
 * Discord 2000字制限内に収める。
 *
 * 【2026-09-18 に直したバグ】
 * 以前は failures → warnings の順に 0 件まで削っていた一方、
 * 「エージェント別」は1件も圧縮していなかった。その結果 09-15 分の日報が
 * "── 失敗・CRITICAL ──\n他2件" となり、**異常だけが消えて正常なエージェント一覧が残った**。
 * 異常を伝えるための日報として機能していなかった。
 *
 * 【優先順位】削ってよい順に:
 *   1. エージェント別      … 正常時の内訳。全文は Vault にある
 *   2. WARN               … 失敗ではない注意
 *   3. 失敗・CRITICAL      … **最後。かつ1件は必ず残す**
 *
 * 未解消 CRITICAL の持ち越し・死活異常・期限切れは圧縮対象にしない（行数が少なく、
 * かつ切ると意味が失われるため）。
 */
export function renderDigest(data: DigestData): string {
  let agentKeep = data.byAgent.length;
  let warningKeep = data.warnings.length;
  let failureKeep = data.failures.length;

  const build = () => render(data, failureKeep, warningKeep, agentKeep);
  let body = build();

  // 1) エージェント別から削る（容量を食っているのはここ）
  while (body.length > DISCORD_LIMIT && agentKeep > 0) {
    agentKeep--;
    body = build();
  }
  // 2) WARN
  while (body.length > DISCORD_LIMIT && warningKeep > 0) {
    warningKeep--;
    body = build();
  }
  // 3) 失敗・CRITICAL。**1件は必ず残す**（0 まで削ると「他N件」だけになる）
  while (body.length > DISCORD_LIMIT && failureKeep > 1) {
    failureKeep--;
    body = build();
  }
  return body.length > DISCORD_LIMIT ? body.slice(0, DISCORD_LIMIT) : body;
}
