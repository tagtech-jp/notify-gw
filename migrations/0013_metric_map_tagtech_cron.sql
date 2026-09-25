-- agent_ledger_export.py により生成(手編集禁止)。
-- 0005 で投入済みの分類との差分だけを追加する(0005 は本番適用済みなので書き換えない)。
-- 追加分は tagtech-cron の20ジョブ。役職タグが無いため agent_ledger では実体なし扱いだが、
-- job_schedule にスケジュールがあるので①日報/報告・③情報収集・⑤自己改善は測定できる。
-- これを入れるまで tagtech-cron の23実体は①③⑤が全件 NULL(測定対象外)だった。
-- 分類しない3件(funding-reminder / heartbeat / digest-watch)の理由は
-- data/autonomy_metric_rules.json の _unclassified_tagtech_cron に記録してある。

INSERT OR IGNORE INTO autonomy_metric_map (job_id, metric, source) VALUES
  ('tagtech-cron/calendar-pipeline', 'exec', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/cxo-worker', 'exec', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/daily-standup', 'report', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/ga4-report', 'report', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/hn-trends', 'intake', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/notion-to-calendar', 'exec', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/pipeline-daily', 'report', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/pipeline-weekly', 'report', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/prompt-self-update-evening', 'improve', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/prompt-self-update-morning', 'improve', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/prompt-self-update-night', 'improve', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/reddit-trends', 'intake', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/revenue-dashboard', 'report', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/seo-checker', 'intake', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/sns-metrics', 'intake', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/task-pipeline', 'exec', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/tiktok-0700', 'exec', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/tiktok-1200', 'exec', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/tiktok-2100', 'exec', 'data/autonomy_metric_rules.json'),
  ('tagtech-cron/youtube-shorts', 'exec', 'data/autonomy_metric_rules.json');
