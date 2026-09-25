/**
 * credential の有効期限監視。
 *
 * 2026-05〜09 に GitHub Actions の CLOUDFLARE_API_TOKEN が失効したまま 4 ヶ月間
 * 誰にも気づかれず CI デプロイが止まっていた。期限のある credential は
 * 「切れてから気づく」のではなく「切れる前に日報へ出す」。
 */

export interface TokenExpiry {
  name: string;
  expiresOn: string;
  daysLeft: number;
  expired: boolean;
}

/**
 * 期限が警告窓に入っている(または既に切れている)ものだけを返す。
 * 日付は YYYY-MM-DD (JST の暦日) として扱う。
 */
export function checkTokenExpiry(
  tokens: Array<{ name: string; expiresOn: string | undefined }>,
  nowMs: number,
  warnDays: number,
): TokenExpiry[] {
  const out: TokenExpiry[] = [];
  for (const t of tokens) {
    if (!t.expiresOn) continue;
    const expiryMs = Date.parse(`${t.expiresOn}T00:00:00Z`);
    if (Number.isNaN(expiryMs)) continue;
    // 期限日当日は daysLeft=0(まだ有効)、翌日から負(期限切れ)になる
    const daysLeft = Math.floor((expiryMs - nowMs) / (24 * 3600 * 1000));
    if (daysLeft <= warnDays) {
      out.push({ name: t.name, expiresOn: t.expiresOn, daysLeft, expired: daysLeft < 0 });
    }
  }
  return out;
}
