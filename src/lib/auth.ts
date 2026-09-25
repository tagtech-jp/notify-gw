/**
 * 手動実行エンドポイントの認証。
 *
 * - 鍵は X-Run-Key ヘッダー優先、無ければ ?key= クエリ
 *   （クエリはCloudflareログやブラウザ履歴に残るためヘッダー推奨）
 * - RUN_KEY 未設定・空のときは常に false（認証なしで通さない）
 * - 長さ一致を確認したうえで定数時間比較
 * - scheduled(cron) には使わないこと
 */

export function extractKey(request: Request): string {
  const header = request.headers.get("x-run-key");
  if (header !== null) return header;
  return new URL(request.url).searchParams.get("key") ?? "";
}

export function isAuthorized(provided: string, expected: string | undefined): boolean {
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;

  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.byteLength !== b.byteLength) return false;

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(a, b);
  }
  // フォールバック: 全バイトを走査する定数時間比較
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
