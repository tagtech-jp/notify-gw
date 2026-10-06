/**
 * 外形監視(2026-10-07 社長指示「すべてやる」)。Web サイトが止まったら #alerts に知らせる。
 *
 * 申告を待つ方式(liveness.ts)は、自分で申告してくる PC の常駐向け。Web サイト(oborozuki.jp など)は自分では申告しないし、
 * 止まったことに自分では気づけない(沈黙は異常)。そこで監視対象の外にいる notify-gw から、確認口を見に行く。
 *
 * - 対象は vars の EXTERNAL_PROBES(「agent_id=URL」をカンマ区切り)。URL は https だけを受け付ける
 * - 15分ごとの cron(速い死活監視と同じ)で GET し、200 かつ JSON の ok が true なら正常
 * - 一時的な揺れで鳴らさないよう、1回の判定で最大3回(5秒おき)試し、全部だめなときだけ異常とする
 * - 異常になったら CRITICAL で #alerts に1回だけ知らせる(未解消の probe-failed があれば重ねない)。
 *   日報の未解消一覧には、解消するまで毎日出る
 * - 正常に戻ったら同じ agent_id + action の success を記録する(日報から機械的に消える。人の確認操作は設けない)
 * - 見に行く先は読み取りだけの確認口(/api/health など)にする。確認のために本番の処理を動かさない(RUNBOOK の原則)
 *
 * このモジュールは「見に行って判定する」だけを持ち、証跡の記録と #alerts への送信は index.ts の recordAndAlert が行う。
 */

export const PROBE_ACTION = "probe-failed";

/**
 * 見に行くときの User-Agent。Cloudflare のサイトは User-Agent の無い要求を弾くことがある
 * (2026-09-22、User-Agent の無い Discord への送信が 403 で2ヶ月届いていなかった教訓)
 */
export const PROBE_USER_AGENT = "notify-gw-probe/1.0 (+https://github.com/tagtech-jp/notify-gw)";

export interface ProbeOptions {
  /** 1回の判定で試す回数 */
  attempts: number;
  /** 試す間隔(ミリ秒) */
  intervalMs: number;
  /** 1回の応答待ち(ミリ秒) */
  timeoutMs: number;
}

export const DEFAULT_PROBE_OPTIONS: ProbeOptions = { attempts: 3, intervalMs: 5000, timeoutMs: 10000 };

/** 「agent_id=URL」をカンマ区切りで読む。https でない・壊れた項目は捨てる(監視を止めないため、例外にしない) */
export function parseExternalProbes(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (raw ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const agentId = part.slice(0, eq).trim();
    const url = part.slice(eq + 1).trim();
    if (!/^[^\s=]+$/.test(agentId)) continue;
    try {
      if (new URL(url).protocol !== "https:") continue;
    } catch {
      continue;
    }
    out.set(agentId, url);
  }
  return out;
}

export interface ProbeResult {
  ok: boolean;
  /** 最後に試したときの HTTP の状態。応答が無ければ null */
  status: number | null;
  /** 異常のときの説明(通知の本文用)。正常なら "ok" */
  detail: string;
  /** 試した回数 */
  attempts: number;
}

interface HealthBody {
  ok?: unknown;
  checks?: Record<string, unknown>;
}

/** 1回分。200 かつ JSON の ok が true なら正常。それ以外は理由を返す(例外にしない) */
async function probeOnce(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ ok: boolean; status: number | null; detail: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { "User-Agent": PROBE_USER_AGENT, Accept: "application/json", "Cache-Control": "no-cache" },
      // 転送(301/302 など)は追わずに異常として扱う(確認口が別の場所へ飛ばされているのは、それ自体が異常)
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return { ok: false, status: null, detail: name === "TimeoutError" ? `${timeoutMs / 1000}秒で応答なし` : `接続できない(${name})` };
  }
  let body: HealthBody | null = null;
  try {
    body = (await response.json()) as HealthBody;
  } catch {
    body = null;
  }
  if (response.status === 200 && body !== null && body.ok === true) {
    return { ok: true, status: 200, detail: "ok" };
  }
  // 確認口が「何がだめか」を返していれば、通知に添える(例: db=false)
  const failedChecks =
    body && body.checks && typeof body.checks === "object"
      ? Object.entries(body.checks)
          .filter(([, value]) => value !== true)
          .map(([key]) => `${key}=false`)
      : [];
  const reason = failedChecks.length > 0 ? `・${failedChecks.join("・")}` : body === null ? "・JSON ではない応答" : "";
  return { ok: false, status: response.status, detail: `HTTP ${response.status}${reason}` };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 確認口を見に行く。最大 attempts 回試し、1回でも正常なら正常。例外は投げない */
export async function probeHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
  options: ProbeOptions = DEFAULT_PROBE_OPTIONS,
): Promise<ProbeResult> {
  let last = { ok: false, status: null as number | null, detail: "未実施" };
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    last = await probeOnce(url, fetchImpl, options.timeoutMs);
    if (last.ok) return { ...last, attempts: attempt };
    if (attempt < options.attempts) await sleep(options.intervalMs);
  }
  return { ...last, attempts: options.attempts };
}
