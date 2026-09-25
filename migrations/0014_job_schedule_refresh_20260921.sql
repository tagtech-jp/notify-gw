-- agent_ledger_export.py により生成(手編集禁止・再生成は scripts/agent_ledger_export.py を実行)。
-- 2026-09-21 の再生成。job_schedule を丸ごと入れ替える(53件)。
--
-- なぜ 0010 を書き換えずに新しい migration にするか:
--   0010 は本番 D1 に適用済み。wrangler はファイル名で適用済みを管理するので、
--   適用済みファイルの中身を変えても本番には二度と流れない(=git と本番が黙って乖離する)。
--   0005 の docstring にもあるとおり「適用済み migration は不変」。差分は新しい番号で足す。
--
-- job_schedule は「定時実行スケジュールの唯一の真実源」で、PRIMARY KEY(job_id)・FK 無しの
-- 参照テーブルなので、DELETE + INSERT で全置換してよい(events 等の履歴には触れない)。
--
-- 生成元: projects/tagtech-automation/src/index.ts の cronToTasks(origin/master f960dd5) /
--        cloudflare/tagtech-cron/src/index.ts の CRON_MAP(origin/chore/claude-devops-setup 367660a) /
--        cloudflare/vault-intel/wrangler.toml / projects/notify-gw/wrangler.jsonc
-- 0010(63件)からの実質差分:
--   削除 12件 … automation 降格6件(cio_daily_news / ciso_security_scan / google_calendar_sync /
--              pipeline_daily / pipeline_weekly / cpo_platform_review の旧 cron "0 14 20 * *")
--              + tagtech-cron 降格6件(daily-standup / prompt-self-update-{morning,evening,night} /
--              revenue-dashboard / youtube-shorts。2026-09-14 降格分だが seed 未再生成だった)
--   追加  2件 … tagtech-automation/cpo_platform_review "0 5 20 * *"(JST 14:00 へ時差修正) /
--              tagtech-cron/cto-tech-monitor "0 21 * * *"(JST 06:00 新設)
-- cron_kind: hourly/daily は期待28日、weekly は 28日=4週で常に4日、monthly のみ窓ごとに再計算する(cron_dom を使う)。

DELETE FROM job_schedule;

INSERT INTO job_schedule (job_id, worker, cron, cron_kind, cron_dom, expected_days_28d, source) VALUES
  ('notify-gw', 'notify-gw', '5 0 * * *', 'daily', NULL, 28, 'projects/notify-gw/wrangler.jsonc:18'),
  ('tagtech-automation/cbo_sales_report', 'tagtech-automation', '30 2 * * 1', 'weekly', NULL, 4, 'projects/tagtech-automation/src/index.ts:226 (cronToTasks)'),
  ('tagtech-automation/cco_calendar_sync', 'tagtech-automation', '0 21 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:257 (cronToTasks)'),
  ('tagtech-automation/cco_clip_gen', 'tagtech-automation', '0 8 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:235 (cronToTasks)'),
  ('tagtech-automation/cdo_data_dashboard', 'tagtech-automation', '10 0 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:209 (cronToTasks)'),
  ('tagtech-automation/cfo_finance_report', 'tagtech-automation', '30 23 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:197 (cronToTasks)'),
  ('tagtech-automation/cfo_monthly_report', 'tagtech-automation', '0 0 1 * *', 'monthly', 1, 1, 'projects/tagtech-automation/src/index.ts:281 (cronToTasks)'),
  ('tagtech-automation/channel_activity', 'tagtech-automation', '30 0 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:213 (cronToTasks)'),
  ('tagtech-automation/chro_health_check', 'tagtech-automation', '0 23 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:181 (cronToTasks)'),
  ('tagtech-automation/chro_mood_monitor', 'tagtech-automation', '0 15,21,3,9 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:290 (cronToTasks)'),
  ('tagtech-automation/clo_compliance_audit', 'tagtech-automation', '10 23 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:189 (cronToTasks)'),
  ('tagtech-automation/cmo_sns_evening', 'tagtech-automation', '0 10 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:244 (cronToTasks)'),
  ('tagtech-automation/cmo_sns_night', 'tagtech-automation', '0 13 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:252 (cronToTasks)'),
  ('tagtech-automation/cmo_sns_noon', 'tagtech-automation', '0 3 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:230 (cronToTasks)'),
  ('tagtech-automation/coo_ops_monitor', 'tagtech-automation', '17 * * * *', 'hourly', NULL, 28, 'projects/tagtech-automation/src/index.ts:218 (cronToTasks)'),
  ('tagtech-automation/cpo_platform_review', 'tagtech-automation', '0 5 20 * *', 'monthly', 20, 1, 'projects/tagtech-automation/src/index.ts:276 (cronToTasks)'),
  ('tagtech-automation/cto_notion_sync', 'tagtech-automation', '0 15,3 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:269 (cronToTasks)'),
  ('tagtech-automation/cto_tech_monitor', 'tagtech-automation', '15 23 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:193 (cronToTasks)'),
  ('tagtech-automation/daily_standup', 'tagtech-automation', '0 23 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:182 (cronToTasks)'),
  ('tagtech-automation/ext_audit_skill_review', 'tagtech-automation', '0 0 * * 1', 'weekly', NULL, 4, 'projects/tagtech-automation/src/index.ts:285 (cronToTasks)'),
  ('tagtech-automation/funding_reminder', 'tagtech-automation', '0 0 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:205 (cronToTasks)'),
  ('tagtech-automation/hn_trends_morning', 'tagtech-automation', '0 22 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:263 (cronToTasks)'),
  ('tagtech-automation/monthly_fixed_expenses', 'tagtech-automation', '0 0 1 * *', 'monthly', 1, 1, 'projects/tagtech-automation/src/index.ts:280 (cronToTasks)'),
  ('tagtech-automation/notion_task_sync', 'tagtech-automation', '0 15,3 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:268 (cronToTasks)'),
  ('tagtech-automation/prompt_self_update_evening', 'tagtech-automation', '0 9 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:240 (cronToTasks)'),
  ('tagtech-automation/prompt_self_update_morning', 'tagtech-automation', '30 0 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:214 (cronToTasks)'),
  ('tagtech-automation/prompt_self_update_night', 'tagtech-automation', '0 13 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:253 (cronToTasks)'),
  ('tagtech-automation/revenue_dashboard', 'tagtech-automation', '0 0 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:204 (cronToTasks)'),
  ('tagtech-automation/task_pipeline_daily', 'tagtech-automation', '0 23 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:183 (cronToTasks)'),
  ('tagtech-automation/tiktok_morning', 'tagtech-automation', '0 22 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:264 (cronToTasks)'),
  ('tagtech-automation/tiktok_night', 'tagtech-automation', '0 12 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:248 (cronToTasks)'),
  ('tagtech-automation/tiktok_noon', 'tagtech-automation', '0 3 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:231 (cronToTasks)'),
  ('tagtech-automation/weekly_ceo_meeting', 'tagtech-automation', '0 2 * * 1', 'weekly', NULL, 4, 'projects/tagtech-automation/src/index.ts:222 (cronToTasks)'),
  ('tagtech-automation/youtube_shorts', 'tagtech-automation', '0 9 * * *', 'daily', NULL, 28, 'projects/tagtech-automation/src/index.ts:239 (cronToTasks)'),
  ('tagtech-cron/calendar-pipeline', 'tagtech-cron', '10 20 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:121 (CRON_MAP)'),
  ('tagtech-cron/cto-tech-monitor', 'tagtech-cron', '0 21 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:127 (CRON_MAP)'),
  ('tagtech-cron/cxo-worker', 'tagtech-cron', '47 21 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:123 (CRON_MAP)'),
  ('tagtech-cron/digest-watch', 'tagtech-cron', '0 1 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:133 (CRON_MAP)'),
  ('tagtech-cron/funding-reminder', 'tagtech-cron', '0 0 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:131 (CRON_MAP)'),
  ('tagtech-cron/ga4-report', 'tagtech-cron', '10 0 * * SUN', 'weekly', NULL, 4, 'cloudflare/tagtech-cron/src/index.ts:137 (CRON_MAP)'),
  ('tagtech-cron/heartbeat', 'tagtech-cron', '5 0 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:132 (CRON_MAP)'),
  ('tagtech-cron/hn-trends', 'tagtech-cron', '0 22 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:128 (CRON_MAP)'),
  ('tagtech-cron/notion-to-calendar', 'tagtech-cron', '30 20 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:122 (CRON_MAP)'),
  ('tagtech-cron/pipeline-daily', 'tagtech-cron', '30 23 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:130 (CRON_MAP)'),
  ('tagtech-cron/pipeline-weekly', 'tagtech-cron', '30 0 * * SUN', 'weekly', NULL, 4, 'cloudflare/tagtech-cron/src/index.ts:138 (CRON_MAP)'),
  ('tagtech-cron/reddit-trends', 'tagtech-cron', '30 22 * * SUN', 'weekly', NULL, 4, 'cloudflare/tagtech-cron/src/index.ts:139 (CRON_MAP)'),
  ('tagtech-cron/seo-checker', 'tagtech-cron', '0 0 * * SUN', 'weekly', NULL, 4, 'cloudflare/tagtech-cron/src/index.ts:136 (CRON_MAP)'),
  ('tagtech-cron/sns-metrics', 'tagtech-cron', '5 0 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:132 (CRON_MAP)'),
  ('tagtech-cron/task-pipeline', 'tagtech-cron', '0 23 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:129 (CRON_MAP)'),
  ('tagtech-cron/tiktok-0700', 'tagtech-cron', '0 22 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:128 (CRON_MAP)'),
  ('tagtech-cron/tiktok-1200', 'tagtech-cron', '0 3 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:134 (CRON_MAP)'),
  ('tagtech-cron/tiktok-2100', 'tagtech-cron', '0 12 * * *', 'daily', NULL, 28, 'cloudflare/tagtech-cron/src/index.ts:135 (CRON_MAP)'),
  ('vault-intel/hn-morning', 'vault-intel', '30 22 * * *', 'daily', NULL, 28, 'cloudflare/vault-intel/wrangler.toml:7');
