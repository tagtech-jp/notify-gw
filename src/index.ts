import type { Env } from "./types";
import { evaluateExpectation, isExpectation, type Expectation } from "./lib/expectation";
import { extractKey, isAuthorized, authenticate } from "./lib/auth";
import {
  insertEvent,
  markDiscordResult,
  countRecentCriticalByFingerprint,
  getLastEventTs,
  aggregateRange,
  listUnsubstantiated,
  listPortingPending,
  listUnresolvedCriticals,
  upsertDigestLog,
  getDigestLog,
  getExpectedBindings,
  upsertBindingReport,
  auditBindings,
  listReportedModels,
  type EventInput,
} from "./lib/db";
import { sendDiscord, buildCriticalPayload } from "./lib/discord";
import { computeFingerprint } from "./lib/fingerprint";
import { nowIso, jstDateString, dayRangeUtc } from "./lib/jst";
import { renderDigest, type DigestData } from "./lib/digest";
import { driftsToUnresolved } from "./lib/unresolved";
import { commitFile } from "./lib/github";
import { renderVaultSummary } from "./lib/vault_digest";
import { checkTokenExpiry } from "./lib/token_expiry";

const DIGEST_CRON = "5 0 * * *"; // JST 09:05

function text(body: string, status: number, headers?: Record<string, string>): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...(headers ?? {}) } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

interface EventRequestBody {
  agent_id: string;
  action: string;
  target?: string;
  /** 省略時は severity から補う(CRITICAL→failure / WARN→skip / INFO→success) */
  result?: "success" | "failure" | "skip";
  severity: "CRITICAL" | "WARN" | "INFO";
  /** target の別名。WSL の vault-sync-once.sh が summary で送るため受け付ける */
  summary?: string;
  evidence_url?: string;
  fingerprint?: string;
  error_kind?: string;
  meta?: Record<string, unknown>;
  /**
   * 「この出力にはこういう実体があるはず」の宣言。受信側が機械的に検証する。
   * 省略時は検証しない(後方互換。既存の送信元は無改造で動く)。
   */
  expect?: Expectation;
}

function isValidEventBody(body: unknown): body is EventRequestBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.agent_id !== "string" || b.agent_id.length === 0) return false;
  if (typeof b.action !== "string" || b.action.length === 0) return false;
  if (b.result !== undefined && b.result !== "success" && b.result !== "failure" && b.result !== "skip") return false;
  if (b.severity !== "CRITICAL" && b.severity !== "WARN" && b.severity !== "INFO") return false;
  if (b.target !== undefined && typeof b.target !== "string") return false;
  if (b.summary !== undefined && typeof b.summary !== "string") return false;
  if (b.evidence_url !== undefined && typeof b.evidence_url !== "string") return false;
  if (b.fingerprint !== undefined && typeof b.fingerprint !== "string") return false;
  if (b.error_kind !== undefined && typeof b.error_kind !== "string") return false;
  if (b.meta !== undefined && (typeof b.meta !== "object" || b.meta === null)) return false;
  if (b.expect !== undefined && !isExpectation(b.expect)) return false;
  return true;
}

/** result 省略時の既定値。severity から素直に決める */
function resultForSeverity(severity: "CRITICAL" | "WARN" | "INFO"): "success" | "failure" | "skip" {
  if (severity === "CRITICAL") return "failure";
  if (severity === "WARN") return "skip";
  return "success";
}

async function handleHealth(env: Env): Promise<Response> {
  try {
    const lastEventTs = await getLastEventTs(env.NOTIFY_DB);
    return json({ ok: true, last_event_ts: lastEventTs, db_ok: true });
  } catch (err) {
    return json(
      { ok: false, last_event_ts: null, db_ok: false, error: err instanceof Error ? err.message : String(err) },
      503,
    );
  }
}

interface RecordInput {
  agent_id: string;
  action: string;
  target?: string;
  result: "success" | "failure" | "skip";
  severity: "CRITICAL" | "WARN" | "INFO";
  errorKind?: string;
  fingerprint?: string;
  evidence_url?: string;
  meta?: Record<string, unknown>;
}

interface RecordOutcome {
  id: number;
  fingerprint: string;
  discordSent: boolean;
  suppressed: boolean;
}

/**
 * 証跡を1件追記し、CRITICAL なら洪水抑制を見て #alerts へ即時通知する。
 * /event と内部生成イベント(binding-drift 等)の共通経路。
 */
async function recordAndAlert(env: Env, input: RecordInput): Promise<RecordOutcome> {
  const errorKind = input.errorKind ?? input.action;
  const fingerprint =
    input.fingerprint ?? (await computeFingerprint(input.agent_id, input.action, errorKind));

  // 洪水抑制の判定は「挿入前」に行う。挿入後に数えると自分自身を含めてしまい常に抑制扱いになる。
  let suppressed = false;
  if (input.severity === "CRITICAL") {
    const windowMin = Number(env.FLOOD_WINDOW_MIN) || 30;
    const sinceIso = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
    const recentCount = await countRecentCriticalByFingerprint(env.NOTIFY_DB, fingerprint, sinceIso);
    suppressed = recentCount > 0;
  }

  const eventInput: EventInput = {
    ts: nowIso(),
    agent_id: input.agent_id,
    action: input.action,
    target: input.target,
    result: input.result,
    severity: input.severity,
    evidence_url: input.evidence_url,
    fingerprint,
    meta: input.meta ? JSON.stringify(input.meta) : undefined,
  };
  const id = await insertEvent(env.NOTIFY_DB, eventInput);

  let discordSent = false;
  if (input.severity === "CRITICAL" && !suppressed) {
    const result = await sendDiscord(
      env.DISCORD_WEBHOOK_ALERTS,
      buildCriticalPayload(
        {
          agentId: input.agent_id,
          action: input.action,
          target: input.target,
          errorKind,
          eventId: id,
          evidenceUrl: input.evidence_url,
        },
        env.MENTION_USER_ID,
      ),
    );
    discordSent = result.ok;
    // 送信結果を元のイベント行に書き足す(§ markDiscordResult のコメント参照)。
    // 失敗しても証跡本体(上のinsertEvent)には影響しない。
    await markDiscordResult(env.NOTIFY_DB, id, discordSent, result.status ?? null);
    if (!result.ok) {
      // 通知失敗でジョブを落とさない。証跡は必ず残す(throwしない)。
      await insertEvent(env.NOTIFY_DB, {
        ts: nowIso(),
        agent_id: "notify-gw",
        action: "discord-send",
        target: "alerts",
        result: "failure",
        severity: "WARN",
        fingerprint: await computeFingerprint("notify-gw", "discord-send", "alerts-failed"),
        meta: JSON.stringify({ original_event_id: id, error: result.error ?? `status_${result.status ?? "unknown"}` }),
      });
    }
  }

  return { id, fingerprint, discordSent, suppressed };
}

/**
 * restrictAgentId が指定されているときは、その agent_id 以外を 403 で弾く。
 * RUN_KEY_MT5 で認証された送信(mt5-trader専用)にだけ渡される(index.ts の /event ルート参照)。
 * 通常の鍵不一致と同じ "Forbidden" を返し、スコープの存在を外部に漏らさない。
 */
async function handleEvent(request: Request, env: Env, restrictAgentId?: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!isValidEventBody(body)) return json({ error: "invalid_body" }, 400);
  if (restrictAgentId !== undefined && body.agent_id !== restrictAgentId) {
    return text("Forbidden", 403);
  }

  // 「成功と言っているが実体があるか」を機械判定する(LLM 不使用)。
  // result は送信側の申告をそのまま残す(events は追記専用で、申告を書き換えない)。
  // 日報側が meta.expectation を見て「実体なし」を ✅ から分けて報告する。
  let meta = body.meta;
  if (body.expect !== undefined && body.expect !== "none") {
    const text =
      typeof body.meta?.text_preview === "string"
        ? body.meta.text_preview
        : (body.target ?? body.summary ?? "");
    meta = { ...(body.meta ?? {}), expectation: evaluateExpectation(body.expect, text) };
  }

  const outcome = await recordAndAlert(env, {
    agent_id: body.agent_id,
    action: body.action,
    target: body.target ?? body.summary,
    result: body.result ?? resultForSeverity(body.severity),
    severity: body.severity,
    errorKind: body.error_kind,
    fingerprint: body.fingerprint,
    evidence_url: body.evidence_url,
    meta,
  });

  return json({
    ok: true,
    id: outcome.id,
    fingerprint: outcome.fingerprint,
    discord_sent: outcome.discordSent,
    suppressed: outcome.suppressed,
  });
}

interface BindingReportBody {
  agent_id: string;
  /** 省略可。バインディングを持たない送信元(WSL の常駐スクリプト等)は死活申告だけを送る */
  bindings?: string[];
  version_hint?: string;
  /**
   * 省略可。自分の vars に設定されているモデル名の自己申告。
   * cto-tech-monitor がこれを集めて各提供元の一覧 API と照合し、deprecation を検知する。
   * 監視対象をプロバイダ単位で固定すると設定変更に追随しないので、
   * 「設定に外部化されているモデル名すべて」をここで申告させる。
   */
  models?: { var: string; model: string }[];
}

function isValidBindingReport(body: unknown): body is BindingReportBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.agent_id !== "string" || b.agent_id.length === 0) return false;
  if (b.bindings !== undefined && (!Array.isArray(b.bindings) || b.bindings.some((x) => typeof x !== "string")))
    return false;
  if (b.version_hint !== undefined && typeof b.version_hint !== "string") return false;
  if (b.models !== undefined) {
    if (!Array.isArray(b.models)) return false;
    // 値だけの配列は受け付けない。どの変数かが分からないと直す場所が特定できない
    if (
      b.models.some(
        (m) =>
          typeof m !== "object" || m === null ||
          typeof (m as { var?: unknown }).var !== "string" ||
          typeof (m as { model?: unknown }).model !== "string",
      )
    )
      return false;
  }
  return true;
}

/**
 * 各 Worker が cron/起動のたびに Object.keys(env) を申告する。
 * 期待値(expected_bindings)との差分をその場で判定し、欠落があれば CRITICAL 証跡を残す
 * (Discord への即時通知と洪水抑制は既存の /event 経路と同じ扱いにするため、ここでも postEvent 相当を行う)。
 */
async function handleBindingReport(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!isValidBindingReport(body)) return json({ error: "invalid_body" }, 400);

  const expected = await getExpectedBindings(env.NOTIFY_DB, body.agent_id);
  if (expected === null) return json({ error: "unknown_agent", agent_id: body.agent_id }, 404);

  const bindings = body.bindings ?? [];
  const present = new Set(bindings);
  const missing = expected.filter((b) => !present.has(b));
  const reportedAt = nowIso();

  await upsertBindingReport(env.NOTIFY_DB, {
    agentId: body.agent_id,
    bindings,
    missing,
    reportedAt,
    versionHint: body.version_hint,
    models: body.models,
  });

  if (missing.length > 0) {
    await recordAndAlert(env, {
      agent_id: body.agent_id,
      action: "binding-drift",
      target: `期待バインディング欠落: ${missing.join(", ")}`,
      result: "failure",
      severity: "CRITICAL",
      errorKind: `binding-missing:${missing.join(",")}`,
      meta: { expected, actual: body.bindings, missing, version_hint: body.version_hint },
    });
  }

  return json({ ok: true, agent_id: body.agent_id, missing, reported_at: reportedAt });
}

/**
 * notify-gw 自身のバインディングを申告する(自分の D1 に直接書く)。
 * NOTIFY_DB が欠落していればそもそもここまで来られないが、
 * secrets の欠落(RUN_KEY / Webhook)はこれで検知できる。
 */
async function selfReportBindings(env: Env): Promise<void> {
  const agentId = "notify-gw";
  const expected = await getExpectedBindings(env.NOTIFY_DB, agentId);
  if (expected === null) return;
  const bindings = Object.keys(env as unknown as Record<string, unknown>);
  const present = new Set(bindings);
  const missing = expected.filter((b) => !present.has(b));
  await upsertBindingReport(env.NOTIFY_DB, { agentId, bindings, missing, reportedAt: nowIso() });
  if (missing.length > 0) {
    await recordAndAlert(env, {
      agent_id: agentId,
      action: "binding-drift",
      target: `期待バインディング欠落: ${missing.join(", ")}`,
      result: "failure",
      severity: "CRITICAL",
      errorKind: `binding-missing:${missing.join(",")}`,
      meta: { expected, actual: bindings, missing },
    });
  }
}

/** ドリフト一覧(欠落 or 申告途絶)。外部からの点検用 */
async function handleBindingAudit(env: Env): Promise<Response> {
  const drifts = await auditBindings(env.NOTIFY_DB, Date.now());
  return json({ ok: drifts.length === 0, drifts });
}

/**
 * 各 Worker が申告したモデル名の一覧。cto-tech-monitor が照合対象を知るために読む。
 * ここは「誰が何を設定しているか」を返すだけで、判定はしない
 * (一覧 API を叩くのは鍵を持つ側の責務であり、notify-gw は LLM 関連の鍵を持たない)。
 */
async function handleModelsReported(env: Env): Promise<Response> {
  const agents = await listReportedModels(env.NOTIFY_DB);
  return json({
    ok: true,
    agents,
    total: agents.reduce((n, a) => n + a.models.length, 0),
  });
}

function previousJstDate(tzOffsetHours: number): string {
  return jstDateString(new Date(Date.now() - 24 * 60 * 60 * 1000), tzOffsetHours);
}

function shiftDate(dateJst: string, days: number): string {
  return new Date(Date.parse(`${dateJst}T00:00:00Z`) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function buildDigestData(env: Env, dateJst: string): Promise<DigestData> {
  const tzOffset = Number(env.TZ_OFFSET_HOURS) || 9;
  const { startUtc, endUtc } = dayRangeUtc(dateJst, tzOffset);
  const agg = await aggregateRange(env.NOTIFY_DB, startUtc, endUtc);
  // 未移植ジョブの増減を出すため、前日分の一覧も引く
  const prev = dayRangeUtc(shiftDate(dateJst, -1), tzOffset);
  const portingPendingPrev = await listPortingPending(env.NOTIFY_DB, prev.startUtc, prev.endUtc);
  const unsubstantiatedPrev = await listUnsubstantiated(env.NOTIFY_DB, prev.startUtc, prev.endUtc);
  // バインディングのドリフトは日報作成時点の実測(集計対象日ではなく「今」の状態)
  const bindingDrifts = await auditBindings(env.NOTIFY_DB, Date.now());
  const tokenExpiries = checkTokenExpiry(
    [{ name: "GITHUB_TOKEN (tagtech-vault PAT)", expiresOn: env.GITHUB_TOKEN_EXPIRES }],
    Date.now(),
    Number(env.TOKEN_WARN_DAYS) || 14,
  );
  // 未解消の CRITICAL は**集計対象日の外まで遡る**。
  // 日報は前日1日分を集計するが、解消されていない異常は解消されるまで毎日出す。
  // 2026-09-15 の Deploy 失敗が3日間気づかれなかったのは、1日分しか見えず
  // 翌日には流れてしまったため(証跡も #alerts も日報も出ていたのに見逃された)。
  // 死活異常も同じ一覧に混ぜる。解消されるまで続く異常という点で CRITICAL と同じ性質で、
  // 実際 tagtech-cron の申告途絶は専用欄に出ていたのに2日間気づかれなかった。
  const unresolvedCriticals = [
    ...(await listUnresolvedCriticals(env.NOTIFY_DB, endUtc)),
    ...driftsToUnresolved(bindingDrifts, endUtc),
  ];
  return {
    dateJst,
    ...agg,
    portingPendingPrev,
    unsubstantiatedPrev,
    bindingDrifts,
    tokenExpiries,
    unresolvedCriticals,
    nowMs: Date.parse(endUtc),
  };
}

/**
 * 日次サマリを Vault(GitHub)へコミットする。
 * Discord の 2000 字制限で切り捨てる情報も、こちらは全件残す。
 * 失敗しても日報送信は止めない。証跡だけは必ず残す。
 */
async function commitVaultSummary(env: Env, data: DigestData): Promise<void> {
  const path = `${env.VAULT_DIGEST_DIR}/notify-gw-${data.dateJst}.md`;
  const result = await commitFile({
    token: env.GITHUB_TOKEN,
    repo: env.VAULT_REPO,
    path,
    message: `notify-gw: 日次証跡サマリ ${data.dateJst}`,
    content: renderVaultSummary(data, nowIso()),
  });

  if (result.ok) {
    await recordAndAlert(env, {
      agent_id: "notify-gw",
      action: "vault-commit",
      target: `${env.VAULT_REPO}/${path}`,
      result: "success",
      severity: "INFO",
      evidence_url: result.commitUrl,
      meta: { date_jst: data.dateJst },
    });
    return;
  }

  // トークン未設定は「まだ配線していない」なので WARN。それ以外の失敗は CRITICAL
  const notConfigured = result.reason === "token_not_configured";
  await recordAndAlert(env, {
    agent_id: "notify-gw",
    action: "vault-commit",
    target: `${env.VAULT_REPO}/${path} へのコミット失敗: ${result.reason}`,
    result: notConfigured ? "skip" : "failure",
    severity: notConfigured ? "WARN" : "CRITICAL",
    errorKind: result.reason ?? "unknown",
    meta: { date_jst: data.dateJst, reason: result.reason, detail: result.detail },
  });
}

async function handleDigestPreview(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tzOffset = Number(env.TZ_OFFSET_HOURS) || 9;
  const dateJst = url.searchParams.get("date") ?? previousJstDate(tzOffset);
  const data = await buildDigestData(env, dateJst);
  return text(renderDigest(data), 200);
}

/** 外部死活監視用: 指定日(既定は前日JST)のダイジェストが送信済みかを digest_log から返す */
async function handleDigestStatus(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tzOffset = Number(env.TZ_OFFSET_HOURS) || 9;
  const dateJst = url.searchParams.get("date") ?? previousJstDate(tzOffset);
  const row = await getDigestLog(env.NOTIFY_DB, dateJst);
  return json({
    date_jst: dateJst,
    sent: row !== null && row.discord_ok === 1,
    sent_at: row?.sent_at ?? null,
    discord_ok: row?.discord_ok ?? 0,
  });
}

async function runDigest(env: Env): Promise<{ ok: boolean; dateJst: string; body: string }> {
  const tzOffset = Number(env.TZ_OFFSET_HOURS) || 9;
  const dateJst = previousJstDate(tzOffset);
  const data = await buildDigestData(env, dateJst);
  const body = renderDigest(data);

  const result = await sendDiscord(env.DISCORD_WEBHOOK_DIGEST, { content: body });

  // Vault へは Discord 送信の成否にかかわらず残す(知識ハブは通知経路と独立)
  await commitVaultSummary(env, data);

  // 申告が途絶したエージェントは WARN 証跡に残す(欠落検知の CRITICAL は申告受信時に出る)。
  // 一度も届いていない「未配線」は日報の1行だけに留め、証跡も #alerts も出さない
  // (配線待ちの状態を障害として扱うと通知が汚れるため)。
  for (const drift of data.bindingDrifts ?? []) {
    if (drift.stale && !drift.neverReported && drift.missing.length === 0) {
      await recordAndAlert(env, {
        agent_id: drift.agent_id,
        action: "binding-report-stale",
        target: `申告途絶(最終 ${drift.reported_at})`,
        result: "skip",
        severity: "WARN",
        errorKind: "binding-report-stale",
        meta: { reported_at: drift.reported_at },
      });
    }
  }

  await upsertDigestLog(env.NOTIFY_DB, { dateJst, sentAt: nowIso(), agg: data, discordOk: result.ok });

  // ダイジェスト送信自体も証跡として自己記録する
  await insertEvent(env.NOTIFY_DB, {
    ts: nowIso(),
    agent_id: "notify-gw",
    action: "digest-send",
    target: dateJst,
    result: result.ok ? "success" : "failure",
    severity: result.ok ? "INFO" : "WARN",
    fingerprint: await computeFingerprint("notify-gw", "digest-send", dateJst),
    meta: JSON.stringify({ date_jst: dateJst, total: data.total, critical: data.critical }),
  });

  return { ok: result.ok, dateJst, body };
}

async function handleDigestRun(env: Env): Promise<Response> {
  const result = await runDigest(env);
  return json(result);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = extractKey(request);

    if (url.pathname === "/health") {
      if (request.method !== "GET") return text("Method Not Allowed", 405, { Allow: "GET" });
      if (!isAuthorized(key, env.RUN_KEY)) return text("Forbidden", 403);
      return handleHealth(env);
    }

    if (url.pathname === "/event") {
      if (request.method !== "POST") return text("Method Not Allowed", 405, { Allow: "POST" });
      // RUN_KEY_MT5(mt5-trader専用)はここでのみ有効。agent_id制限は handleEvent 側で掛ける。
      const authed = authenticate(key, env);
      if (authed === null) return text("Forbidden", 403);
      return handleEvent(request, env, authed === "run_key_mt5" ? "mt5-trader" : undefined);
    }

    if (url.pathname === "/digest/preview") {
      if (request.method !== "GET") return text("Method Not Allowed", 405, { Allow: "GET" });
      if (!isAuthorized(key, env.RUN_KEY)) return text("Forbidden", 403);
      return handleDigestPreview(request, env);
    }

    // /heartbeat は /bindings/report のエイリアス。
    // WSL の vault-sync-once.sh が /heartbeat を叩く実装になっているため、
    // 送信元スクリプトを変更せずに死活申告を受けられるようにしている。
    if (url.pathname === "/bindings/report" || url.pathname === "/heartbeat") {
      if (request.method !== "POST") return text("Method Not Allowed", 405, { Allow: "POST" });
      if (!isAuthorized(key, env.RUN_KEY)) return text("Forbidden", 403);
      return handleBindingReport(request, env);
    }

    if (url.pathname === "/bindings/audit") {
      if (request.method !== "GET") return text("Method Not Allowed", 405, { Allow: "GET" });
      if (!isAuthorized(key, env.RUN_KEY)) return text("Forbidden", 403);
      return handleBindingAudit(env);
    }

    if (url.pathname === "/models/reported") {
      if (request.method !== "GET") return text("Method Not Allowed", 405, { Allow: "GET" });
      if (!isAuthorized(key, env.RUN_KEY)) return text("Forbidden", 403);
      return handleModelsReported(env);
    }

    if (url.pathname === "/digest/status") {
      if (request.method !== "GET") return text("Method Not Allowed", 405, { Allow: "GET" });
      if (!isAuthorized(key, env.RUN_KEY)) return text("Forbidden", 403);
      return handleDigestStatus(request, env);
    }

    if (url.pathname === "/digest/run") {
      if (request.method !== "POST") return text("Method Not Allowed", 405, { Allow: "POST" });
      if (!isAuthorized(key, env.RUN_KEY)) return text("Forbidden", 403);
      return handleDigestRun(env);
    }

    return text("Not Found", 404);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === DIGEST_CRON) {
      // 自己申告は cron 実行時のみ。手動の /digest/run では走らせない
      // (preview と run の本文が一致するという契約を壊さないため)
      ctx.waitUntil(selfReportBindings(env).then(() => runDigest(env)).then(() => undefined));
      return;
    }
    // 対応表にないcronが発火した場合の証跡だけ残す(通知はしない。tagtech-cronの:160と役割分担)
    ctx.waitUntil(
      insertEvent(env.NOTIFY_DB, {
        ts: nowIso(),
        agent_id: "notify-gw",
        action: "scheduled",
        target: controller.cron,
        result: "skip",
        severity: "WARN",
        fingerprint: await computeFingerprint("notify-gw", "scheduled", controller.cron),
      }).then(() => undefined),
    );
  },
};
