export interface Env {
  NOTIFY_DB: D1Database;
  RUN_KEY?: string;
  DISCORD_WEBHOOK_ALERTS?: string;
  DISCORD_WEBHOOK_DIGEST?: string;
  MENTION_USER_ID?: string;
  /** tagtech-vault へ日次サマリをコミットする fine-grained PAT。未設定なら skip して WARN 証跡 */
  GITHUB_TOKEN?: string;
  TZ_OFFSET_HOURS: string;
  FLOOD_WINDOW_MIN: string;
  DIGEST_HOUR_JST: string;
  /** Vault サマリのコミット先 */
  VAULT_REPO: string;
  VAULT_DIGEST_DIR: string;
  /** GITHUB_TOKEN の有効期限(YYYY-MM-DD)。期限切れの沈黙を防ぐため日報で事前に警告する */
  GITHUB_TOKEN_EXPIRES?: string;
  /** 期限の何日前から警告するか */
  TOKEN_WARN_DAYS: string;
}

export function requireSecrets(env: Env, keys: Array<keyof Env>): string[] {
  const missing: string[] = [];
  for (const key of keys) {
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) missing.push(String(key));
  }
  return missing;
}
