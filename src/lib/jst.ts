export function nowIso(): string {
  return new Date().toISOString();
}

/** JST(または任意のtzOffsetHours)基準の日付文字列 'YYYY-MM-DD' */
export function jstDateString(date: Date, tzOffsetHours = 9): string {
  const jst = new Date(date.getTime() + tzOffsetHours * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/**
 * 'YYYY-MM-DD'(指定タイムゾーンでの1日)の開始・終了をUTC ISO文字列で返す。
 * 例: dateJst='2026-09-09', tzOffsetHours=9
 *  -> startUtc='2026-09-08T15:00:00.000Z', endUtc='2026-09-09T15:00:00.000Z'
 */
export function dayRangeUtc(dateJst: string, tzOffsetHours: number): { startUtc: string; endUtc: string } {
  const offsetMs = tzOffsetHours * 60 * 60 * 1000;
  const startMs = Date.parse(`${dateJst}T00:00:00.000Z`) - offsetMs;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { startUtc: new Date(startMs).toISOString(), endUtc: new Date(endMs).toISOString() };
}
