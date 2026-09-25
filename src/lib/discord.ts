/**
 * Discord 送信の唯一の出口。
 *
 * 契約(既存4系統と同じ): 通知失敗でジョブを落とさない。ここでは throw しない。
 * 5xx は1回だけリトライ、4xxは即失敗。Webhook 未設定なら送信をスキップする。
 */

export interface DiscordPayload {
  content?: string;
  allowed_mentions?: { parse?: string[]; users?: string[] };
}

export interface DiscordSendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const CONTENT_LIMIT = 1900;

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function sendDiscord(webhookUrl: string | undefined, payload: DiscordPayload): Promise<DiscordSendResult> {
  if (typeof webhookUrl !== "string" || webhookUrl.length === 0) {
    console.error("[notify-gw] Discord webhook URL not configured, skipping send");
    return { ok: false, error: "webhook_not_configured" };
  }

  const body = JSON.stringify({
    ...payload,
    content: payload.content !== undefined ? truncate(payload.content, CONTENT_LIMIT) : undefined,
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "notify-gw/1.0" },
        body,
      });
      if (res.ok) return { ok: true, status: res.status };
      if (res.status >= 500 && attempt === 0) continue; // 5xxのみ1回リトライ
      return { ok: false, status: res.status };
    } catch (err) {
      if (attempt === 0) continue;
      console.error("[notify-gw] Discord send failed", err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: false, error: "exhausted_retries" };
}

export interface CriticalContext {
  agentId: string;
  action: string;
  target?: string;
  errorKind?: string;
  eventId: number;
  evidenceUrl?: string;
}

/**
 * error_kind ごとの「何が起きたか」と「次にすべきこと」。
 *
 * 【2026-09-18 に追加】それまでの本文は
 *   `github-actions/tagtech-automation deploy: e217444ffcb5...`
 * だけで、SHA を見せられても何をすべきか分からなかった。
 *
 * キーは error_kind の**接頭辞**で引く(binding-missing:NOTIFY_GW のように
 * 対象名が付くため)。未知の種別でも必ず既定のテンプレートを返す。
 * 「テンプレートが無いので出さない」は最悪の挙動なので、そこには倒さない。
 */
const TEMPLATES: Array<{ prefix: string; what: string; todo: string }> = [
  {
    prefix: "deploy_",
    what: "本番デプロイが失敗しました",
    todo: "Actions のログを確認 → 原因を修正して PR → マージで再デプロイ",
  },
  {
    prefix: "binding-missing",
    what: "必要なバインディングが本番から欠落しています",
    todo: "wrangler.toml/jsonc を確認 → 欠落分を復旧 → 再デプロイ（古い版が配られた可能性）",
  },
  {
    prefix: "binding-report-stale",
    what: "この Worker から死活の申告が届いていません",
    todo: "cron が動いているか wrangler tail で確認 → 申告コードが巻き戻っていないか git log --all -S で確認",
  },
  {
    prefix: "job-failure",
    what: "定期ジョブが失敗しました",
    todo: "wrangler tail でログ確認 → 再実行は手動実行の口から（&dry=1 で先に中身を確認）",
  },
  {
    prefix: "unmapped-cron",
    what: "対応表にない cron が発火しました",
    todo: "CRON_MAP と wrangler の crons を 1:1 に揃える（片方だけ変更された可能性）",
  },
];

function templateFor(errorKind: string | undefined, action: string): { what: string; todo: string } {
  const key = errorKind ?? action;
  const hit = TEMPLATES.find((t) => key.startsWith(t.prefix));
  if (hit) return hit;
  // 未知の種別。agent_id + action から言えることだけを言う
  return {
    what: `${action} が CRITICAL で終了しました`,
    todo: "証跡の meta と evidence_url を確認 → 原因を特定",
  };
}

/** 対象が長すぎると本文が上限を超える。追跡できる長さは残して切る */
const TARGET_MAX = 300;

export function buildCriticalPayload(ctx: CriticalContext, mentionUserId: string | undefined): DiscordPayload {
  const mention = mentionUserId ? `<@${mentionUserId}> ` : "";
  const { what, todo } = templateFor(ctx.errorKind, ctx.action);
  const where = ctx.evidenceUrl ? ctx.evidenceUrl : `証跡ID e-${ctx.eventId} を D1 で照会`;

  const lines = [
    `${mention}🔴 CRITICAL: ${what}`,
    `対象: ${ctx.agentId} / ${ctx.action}`,
  ];
  if (ctx.target) lines.push(`詳細: ${truncate(ctx.target, TARGET_MAX)}`);
  lines.push(`確認: ${where}`, `対応: ${todo}`, `証跡ID: e-${ctx.eventId}`);

  return {
    content: truncate(lines.join("\n"), CONTENT_LIMIT),
    allowed_mentions: mentionUserId ? { users: [mentionUserId] } : { parse: [] },
  };
}
