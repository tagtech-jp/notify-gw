import { createFakeD1 } from "./fakeD1";
import type { Env } from "../../src/types";

/** テスト用の Env。個別のケースで上書きしたいものだけ overrides で渡す */
export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NOTIFY_DB: createFakeD1(),
    RUN_KEY: "test-run-key",
    DISCORD_WEBHOOK_ALERTS: "https://discord.test/alerts",
    DISCORD_WEBHOOK_DIGEST: "https://discord.test/digest",
    MENTION_USER_ID: "12345",
    TZ_OFFSET_HOURS: "9",
    FLOOD_WINDOW_MIN: "30",
    DIGEST_HOUR_JST: "9",
    VAULT_REPO: "tagtech-jp/tagtech-vault",
    VAULT_DIGEST_DIR: "digest",
    TOKEN_WARN_DAYS: "14",
    ...overrides,
  };
}
