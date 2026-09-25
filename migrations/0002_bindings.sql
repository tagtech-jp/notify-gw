-- 期待バインディング台帳(drift 検知の唯一の真実源。増減はこの表だけ直せばよい)
CREATE TABLE expected_bindings (
  agent_id    TEXT PRIMARY KEY,           -- 'tagtech-cron' 等。events.agent_id の接頭辞と揃える
  bindings    TEXT NOT NULL,              -- JSON配列: ["NOTIFY_GW","WATCHDOG_STATE"]
  note        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 実申告(各Workerがcron/起動のたびに Object.keys(env) を送る。最終申告で上書き)
CREATE TABLE binding_reports (
  agent_id      TEXT PRIMARY KEY,
  bindings      TEXT NOT NULL,            -- JSON配列: 実際に env に存在したキー
  missing       TEXT NOT NULL,            -- JSON配列: 期待値のうち欠落していたもの
  reported_at   TEXT NOT NULL,            -- ISO8601 UTC
  version_hint  TEXT                      -- 任意: デプロイ識別子など
);

INSERT INTO expected_bindings (agent_id, bindings, note) VALUES
  ('notify-gw',          '["NOTIFY_DB","RUN_KEY","DISCORD_WEBHOOK_ALERTS","DISCORD_WEBHOOK_DIGEST"]', '証跡層本体。NOTIFY_DB 欠落で全証跡停止'),
  ('tagtech-cron',       '["NOTIFY_GW","NOTIFY_GW_KEY","WATCHDOG_STATE","DISCORD_WEBHOOK_URL","DISCORD_WEBHOOK_ALERTS"]', 'watchdog + 21ジョブ'),
  ('tagtech-automation', '["NOTIFY_GW","NOTIFY_GW_KEY","TAGTECH_STATE"]', '38タスク。2026-09-12 に NOTIFY_GW 欠落版が配られた実績あり'),
  ('vault-intel',        '["NOTIFY_GW","NOTIFY_GW_KEY","GITHUB_TOKEN"]', 'HN朝刊');
