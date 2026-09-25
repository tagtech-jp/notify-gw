-- agents テーブル(0001_init.sql)を「非推奨」として明示する。テーブルは削除しない。
--
-- 経緯 (2026-09-14):
--   Phase 5-2 で「agents 台帳に現行系統を登録する」計画だったが、並行して別セッションが
--   agent_ledger(0004〜0006, feat/autonomy-v1) を設計しており、そちらに一本化することを社長が決定した。
--
-- agent_ledger に寄せる理由:
--   1. agents.agent_id は PRIMARY KEY のため「1役職が複数の実行実体を持つ」を表現できない
--      (例: CMO は tagtech-automation の cronToTasks 上で7タスクを担当する)
--   2. agents は行の書き換えを前提にしており、events と同じ追記専用(訂正も追記)の思想に合わない
--   3. 台帳を2つ持つと「実態と台帳の乖離」を自分たちで作ることになる
--
-- 削除しない理由: Never auto-delete。0001_init.sql の履歴と整合を保ち、
-- 万一 agent_ledger 側の設計が覆ったときに戻せるようにしておく。
-- 現時点で agents は 0 件・コード上の参照も 0 箇所(src/ に SELECT/INSERT なし)。
--
-- SQLite はテーブルコメントを持たないため、_deprecations に残す。
CREATE TABLE IF NOT EXISTS _deprecations (
  object_name TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  successor   TEXT,
  decided_at  TEXT NOT NULL
);

INSERT OR REPLACE INTO _deprecations (object_name, kind, reason, successor, decided_at) VALUES
  ('agents', 'table',
   '1役職=複数実行実体を表現できず(PRIMARY KEY 制約)、追記専用の思想にも合わないため非推奨。参照・書き込みを新規に追加しないこと。削除もしない(Never auto-delete)',
   'agent_ledger (0004_agent_ledger.sql)',
   '2026-09-14');
