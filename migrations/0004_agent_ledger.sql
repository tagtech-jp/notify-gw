-- 役職(69名)と実行実体(Worker/cron)を突き合わせる追記専用台帳。
--
-- 既存の agents テーブル(0001_init.sql)には手を付けない。agent_id が PRIMARY KEY のため
--   (a) 1役職が複数の実行実体を持つ (CMO は cronToTasks 上7タスク)
--   (b) 訂正は行の書き換えではなく新しい断面の追記で行う
-- のどちらも表現できないため、別テーブルとして新設する。
CREATE TABLE agent_ledger (
  rev               INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          TEXT NOT NULL,                    -- 1回のエクスポート単位(ISO8601 UTC)。最新断面の判定キー
  recorded_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  agent_id          TEXT NOT NULL,                    -- scripts/role_registry.py の role_code (CEO / BU_開発部 / KA_開発部_1 / JP_開発部_1)
  role_ja           TEXT NOT NULL,                    -- 役職
  level             TEXT NOT NULL CHECK(level IN ('CxO','部長','係長','一般社員')),
  department        TEXT,                             -- 部門。CxO は部門を持たないので NULL
  worker            TEXT,                             -- 担当Worker名。NULL = 実行実体なし(推測で埋めない)
  job_id            TEXT,                             -- events.agent_id と完全一致する突合キー。NULL = 実行実体なし
  cron              TEXT,                             -- 担当cron(UTC。Cron TriggerにTZ設定は存在しない)。NULL = 実行実体なし
  expected_days_28d INTEGER NOT NULL DEFAULT 0,       -- cron から算出した「28日間で発火する日数」。0 = 実体なし
  model             TEXT,                             -- 使用モデル(ローカルPython経路とCloudflare経路の2系統を併記)
  active            INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),  -- 有効フラグ
  source            TEXT NOT NULL,                    -- 出典 file:line。出典のない実体主張を作らないための必須列
  note              TEXT
);

CREATE INDEX idx_agent_ledger_agent ON agent_ledger(agent_id, rev);
CREATE INDEX idx_agent_ledger_job   ON agent_ledger(job_id);
CREATE INDEX idx_agent_ledger_batch ON agent_ledger(batch_id);

-- 物理ガード: 追記専用を DB 側で強制する(アプリ側の規律に依存しない)。
CREATE TRIGGER agent_ledger_no_update BEFORE UPDATE ON agent_ledger
BEGIN
  SELECT RAISE(ABORT, 'agent_ledger is append-only: insert a new batch_id instead of UPDATE');
END;

CREATE TRIGGER agent_ledger_no_delete BEFORE DELETE ON agent_ledger
BEGIN
  SELECT RAISE(ABORT, 'agent_ledger is append-only: DELETE is forbidden, supersede with a new batch_id');
END;

-- 最新断面。エクスポートは毎回69名全件を書き出すので、最新 batch_id が常に完全な1断面になる。
-- (キー単位の「最新行」方式にすると、実体ありから実体なしへの訂正で古い行が残ってしまう)
CREATE VIEW agent_ledger_current AS
SELECT * FROM agent_ledger WHERE batch_id = (SELECT MAX(batch_id) FROM agent_ledger);

-- どのジョブがどの自律度項目の根拠になるかの対応表。
-- LIKE パターンをビューに埋め込むと恣意的な分類が SQL に隠れるため、人がレビューできる
-- データとして外に出す。唯一の真実源は tagtech リポジトリの data/autonomy_metric_rules.json。
-- ④証跡記録(trace)と⑥自律判断(judge)は events の action/列で機械判定するため、この表には現れない。
CREATE TABLE autonomy_metric_map (
  job_id TEXT NOT NULL,                               -- events.agent_id と完全一致
  metric TEXT NOT NULL CHECK(metric IN ('report','exec','intake','improve')),
  source TEXT NOT NULL,
  PRIMARY KEY (job_id, metric)
);
