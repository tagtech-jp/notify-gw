/**
 * Vault へ流す日次証跡サマリ(Markdown)。
 *
 * Discord の日報は 2000 字制限で切り捨てるが、こちらは全件を残す。
 * 日報と同じく SQL 集計のみで作る(LLM 不使用)。
 */
import { reasonLabel } from "./expectation";
import { taskCount, type DigestData } from "./digest";

export function renderVaultSummary(data: DigestData, generatedAt: string): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(`date: ${data.dateJst}`);
  lines.push(`total: ${data.total}`);
  lines.push(`success: ${data.success}`);
  lines.push(`failure: ${data.failure}`);
  lines.push(`skip: ${data.skip}`);
  lines.push(`critical: ${data.critical}`);
  lines.push(`generated_at: ${generatedAt}`);
  lines.push("source: notify-gw (D1 events の SQL 集計のみ・生成LLM不使用)");
  lines.push("---");
  lines.push("");
  lines.push(`# TagTech 日報 ${data.dateJst} (JST)`);
  lines.push("");
  lines.push(`実行 ${data.total} 件 = 成功 ${data.success} / 失敗 ${data.failure} / スキップ ${data.skip}（うち CRITICAL ${data.critical}）`);
  lines.push("");

  // Discord の 2000 字制限で日報は件数の1行に畳んでいるので、全一覧はここに残す。
  // 「どのタスクが実体を持たないか」を毎日追える唯一の場所になる。
  const unsub = data.unsubstantiated ?? [];
  if (unsub.length > 0) {
    const design = unsub.filter((r) => r.reason === "deterministic_via_llm");
    const missing = unsub.filter((r) => r.reason !== "deterministic_via_llm");
    lines.push("## 実体の伴わない成功");
    lines.push("");
    lines.push(
      // タスク数で数える(digest.ts の taskCount と同じ基準)。イベント数だと同じタスクが
      // 1日に何度も落ちた分だけ膨らみ、Discord 日報の件数と一致しなくなる(2026-09-22 判断1)。
      `成功と申告されたが期待した実体を確認できなかったもの。設計上の誤り ${taskCount(design)} 件 / 実体なし ${taskCount(missing)} 件（タスク数）。`,
    );
    lines.push("");
    lines.push("| 区分 | エージェント | action | 理由 | 回数 |");
    lines.push("|---|---|---|---|---|");
    for (const r of [...design, ...missing]) {
      const kind = r.reason === "deterministic_via_llm" ? "設計上の誤り" : "実体なし";
      lines.push(`| ${kind} | ${escapeCell(r.agent_id)} | ${escapeCell(r.action)} | ${escapeCell(reasonLabel(r.reason as never) || r.reason)} | ${r.count} |`);
    }
    lines.push("");
  }

  lines.push("## 失敗・CRITICAL");
  if (data.failures.length === 0) {
    lines.push("");
    lines.push("なし");
  } else {
    lines.push("");
    lines.push("| 証跡ID | エージェント | action | 内容 | 回数 |");
    lines.push("|---|---|---|---|---|");
    for (const f of data.failures) {
      lines.push(`| e-${f.id} | ${f.agent_id} | ${f.action} | ${escapeCell(f.summary)} | ${f.count} |`);
    }
  }
  lines.push("");

  if (data.warnings.length > 0) {
    lines.push("## 注意 (WARN)");
    lines.push("");
    lines.push("| 証跡ID | エージェント | action | 内容 | 回数 |");
    lines.push("|---|---|---|---|---|");
    for (const w of data.warnings) {
      lines.push(`| e-${w.id} | ${w.agent_id} | ${w.action} | ${escapeCell(w.summary)} | ${w.count} |`);
    }
    lines.push("");
  }

  if (data.portingPending.length > 0) {
    lines.push(`## 未移植ジョブ (${data.portingPending.length})`);
    lines.push("");
    for (const a of data.portingPending) lines.push(`- ${a}`);
    lines.push("");
  }

  const drifts = data.bindingDrifts ?? [];
  if (drifts.length > 0) {
    lines.push("## 死活・バインディング異常");
    lines.push("");
    for (const d of drifts) {
      const reasons: string[] = [];
      if (d.missing.length > 0) reasons.push(`欠落: ${d.missing.join(", ")}`);
      if (d.neverReported) reasons.push("申告なし(未配線)");
      else if (d.stale) reasons.push(`申告途絶(最終 ${d.reported_at})`);
      lines.push(`- **${d.agent_id}**: ${reasons.join(" / ")}`);
    }
    lines.push("");
  }

  lines.push("## エージェント別");
  lines.push("");
  lines.push("| エージェント | 実行 | 成功 | 失敗 | スキップ |");
  lines.push("|---|---|---|---|---|");
  for (const a of data.byAgent) {
    lines.push(`| ${a.agent_id} | ${a.total} | ${a.success} | ${a.failure} | ${a.skip} |`);
  }
  lines.push("");

  return lines.join("\n");
}

/** Markdown テーブルを壊さないよう最低限だけ処理する */
function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
