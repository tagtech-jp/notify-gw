-- 証跡イベント(全行動の一次記録。UPDATE/DELETE しない追記専用)
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,              -- ISO8601 UTC
  agent_id    TEXT NOT NULL,              -- 例: 'tagtech-cron/job-hn-fetch'
  action      TEXT NOT NULL,              -- 例: 'fetch', 'commit', 'notify', 'deploy'
  target      TEXT,                       -- 対象(URL, repo, file 等)
  result      TEXT NOT NULL CHECK(result IN ('success','failure','skip')),
  severity    TEXT NOT NULL CHECK(severity IN ('CRITICAL','WARN','INFO')),
  evidence_url TEXT,                      -- コミットハッシュURL、Discord msg 等の証拠リンク
  fingerprint TEXT NOT NULL,              -- 重複判定キー: hash(agent_id + action + エラー種別)
  meta        TEXT,                       -- JSON 追加情報
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_fingerprint_ts ON events(fingerprint, ts);

-- エージェント台帳(入力層: 責任範囲の定義とひも付く)
CREATE TABLE agents (
  agent_id    TEXT PRIMARY KEY,
  role        TEXT,                       -- 役職名
  scope       TEXT,                       -- 責任範囲(Notion DB 名・チャンネル・コード領域)
  notion_url  TEXT,
  active      INTEGER NOT NULL DEFAULT 1
);

-- ダイジェスト送信ログ(ダイジェスト自体の証跡)
CREATE TABLE digest_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date_jst    TEXT NOT NULL UNIQUE,       -- 'YYYY-MM-DD'
  sent_at     TEXT,
  total       INTEGER, success INTEGER, failure INTEGER, critical INTEGER,
  discord_ok  INTEGER NOT NULL DEFAULT 0
);
