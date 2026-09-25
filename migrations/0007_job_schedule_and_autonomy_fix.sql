-- 自律度計測の誤検知3件を修正する。
--
-- (A) 日付指定 cron の過小評価: expected_days_28d は台帳に凍結された値だが集計窓は now で動く。
--     窓が対象日を外れると本来の期待値は 0 なのに max(...,1) で切り上げていたため、
--     月次ジョブ(毎月1日/20日)が「1日は動くべき」と誤って要求され m2_exec=0 になっていた。
-- (B) 実体なし役職の 0 点化: entity_count=0 の54役職が「期待1・実績0」で 0 点になり、
--     組織平均を不当に沈めていた。0点(やるべきなのにやっていない)と未測定は別物。
-- (C) 台帳未登録実体の過小評価: tagtech-cron/* 等は cron が台帳に無く一律「日次28」と仮定していたため、
--     週次ジョブ(seo-checker / ga4-report / pipeline-weekly / reddit-trends)を7倍過小評価していた。
--
-- 方針: 「スケジュール」を「役職への帰属」から分離し(job_schedule)、期待値は窓ごとに解決する。
--       期待値が 0 または不明なら点数は NULL(未測定) とし、0点と区別する。

-- 定時実行スケジュールの唯一の真実源。agent_ledger の cron / expected_days_28d 列は
-- 0007 以降この表に置き換わる(追記専用テーブルなので列は残すが参照しない)。
-- 役職に紐づかない実体(tagtech-cron の各ジョブ等)もここには載るので、期待値を正しく出せる。
CREATE TABLE job_schedule (
  job_id            TEXT PRIMARY KEY,   -- events.agent_id と完全一致
  worker            TEXT NOT NULL,
  cron              TEXT NOT NULL,      -- UTC(Cron Trigger に TZ 設定は存在しない)
  cron_kind         TEXT NOT NULL CHECK(cron_kind IN ('hourly','daily','weekly','monthly')),
  cron_dom          INTEGER,            -- monthly のときだけ対象日(1-31)。他は NULL
  expected_days_28d INTEGER NOT NULL,   -- hourly/daily=28 / weekly=4(28日=4週で暦非依存) / monthly は参考値(窓ごとに再計算する)
  source            TEXT NOT NULL       -- 出典 file:line
);

-- 集計窓の上書き。通常は空で、空なら now から算出する(従来どおり)。
-- 用途は2つ: 固定日付での回帰テストと、「先月の自律度を再計算する」運用。
-- 消し忘れると窓が固定されたままになるので、全ビューが window_source を出して検知できるようにする。
CREATE TABLE autonomy_window_override (
  start_utc TEXT NOT NULL,
  end_utc   TEXT NOT NULL
);

DROP VIEW autonomy_v1_by_role;
DROP VIEW autonomy_role_expected;
DROP VIEW autonomy_v1;
DROP VIEW autonomy_base;
DROP VIEW autonomy_subjects;
DROP VIEW autonomy_evidence;
DROP VIEW autonomy_window;

-- 集計窓: 直近28 JST日(当日は不完全なので除外)。上書き行があればそちらを使う。
CREATE VIEW autonomy_window AS
SELECT
  COALESCE((SELECT start_utc FROM autonomy_window_override LIMIT 1),
           strftime('%Y-%m-%dT15:00:00.000Z', date('now','+9 hours','-29 days'))) AS start_utc,
  COALESCE((SELECT end_utc FROM autonomy_window_override LIMIT 1),
           strftime('%Y-%m-%dT15:00:00.000Z', date('now','+9 hours','-1 day')))   AS end_utc,
  CASE WHEN EXISTS(SELECT 1 FROM autonomy_window_override) THEN 'override' ELSE 'live' END AS window_source;

CREATE VIEW autonomy_evidence AS
SELECT e.id, e.agent_id, e.action, e.result, e.severity, e.evidence_url, e.meta,
       date(e.ts, '+9 hours') AS jst_day
FROM events e, autonomy_window w
WHERE e.ts >= w.start_utc AND e.ts < w.end_utc;

-- ジョブごとの「この窓で何日動くはずだったか」。
-- hourly/daily/weekly は 28日=4週なので凍結値がそのまま正しい。
-- monthly だけは窓に対象日が含まれるかで 0/1/2 に変わるため、ここで毎回計算し直す。
-- 28日窓が触れる月は最大2つなので、候補は「窓開始の月の cron_dom 日」と「窓末日の月の cron_dom 日」の2つで足りる。
CREATE VIEW job_expected AS
SELECT
  job_id, worker, cron, cron_kind, cron_dom, ws_day, we_day,
  CASE
    WHEN cron_kind <> 'monthly' THEN expected_days_28d
    ELSE
      -- 候補日が「実在する日か(31日→翌月1日への桁あふれでないか)」と「窓内か」を両方見る
      (CASE WHEN cand_a IS NOT NULL AND CAST(strftime('%d', cand_a) AS INTEGER) = cron_dom
                 AND cand_a >= ws_day AND cand_a < we_day THEN 1 ELSE 0 END)
    + (CASE WHEN cand_b IS NOT NULL AND cand_b <> cand_a
                 AND CAST(strftime('%d', cand_b) AS INTEGER) = cron_dom
                 AND cand_b >= ws_day AND cand_b < we_day THEN 1 ELSE 0 END)
  END AS expected_days
FROM (
  SELECT
    s.job_id, s.worker, s.cron, s.cron_kind, s.cron_dom, s.expected_days_28d,
    date(w.start_utc, '+9 hours')          AS ws_day,   -- 窓の最初の JST 日
    date(w.end_utc,   '+9 hours')          AS we_day,   -- 窓の終端(この日は含まない)
    date(date(w.start_utc, '+9 hours'), 'start of month', '+' || (s.cron_dom - 1) || ' days') AS cand_a,
    date(date(w.end_utc, '+9 hours', '-1 day'), 'start of month', '+' || (s.cron_dom - 1) || ' days') AS cand_b
  FROM job_schedule s CROSS JOIN autonomy_window w
);

-- 評価対象: スケジュールがある job_id ∪ 台帳に実体がある job_id ∪ 窓内に証跡を出した agent_id。
-- 3つ目を入れるのは「どこにも登録が無いのに動いている実体」を隠さないため。
CREATE VIEW autonomy_subjects AS
SELECT job_id AS subject FROM job_schedule
UNION
SELECT job_id AS subject FROM agent_ledger_current WHERE job_id IS NOT NULL
UNION
SELECT agent_id AS subject FROM autonomy_evidence;

CREATE VIEW autonomy_base AS
SELECT
  s.subject,
  l.agent_id, l.role_ja, l.level, l.department,
  je.cron, je.cron_kind,
  CASE WHEN l.job_id IS NULL THEN 0 ELSE 1 END AS ledger_registered,
  -- 期待稼働日数。スケジュール不明(イベント駆動の実体など)は NULL のままにして推測しない。
  je.expected_days AS expected_days,
  CASE WHEN je.job_id IS NULL THEN 'unknown' ELSE 'schedule' END AS expected_basis,
  (SELECT COUNT(*) FROM autonomy_evidence ev WHERE ev.agent_id = s.subject) AS events_total,
  (SELECT COUNT(*) FROM autonomy_evidence ev WHERE ev.agent_id = s.subject AND ev.result = 'success') AS success_total,
  (SELECT COUNT(*) FROM autonomy_evidence ev WHERE ev.agent_id = s.subject AND ev.result = 'failure') AS failure_total,
  (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject AND ev.result = 'success') AS success_days,
  (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject AND ev.result = 'success'
      AND ev.action IN ('run','scheduled','deploy')) AS exec_days,
  (SELECT COUNT(*) FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject AND (ev.evidence_url IS NOT NULL OR ev.meta LIKE '{%')) AS traceable_total,
  (SELECT COUNT(DISTINCT CASE WHEN ev.result = 'skip' THEN 'skip' ELSE ev.action END)
     FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject
      AND (ev.result = 'skip'
           OR ev.action IN ('cron-unmapped','binding-drift','binding-report-stale',
                            'deadline-approaching','deadline-overdue','porting-pending'))) AS decision_kinds,
  EXISTS(SELECT 1 FROM autonomy_metric_map m WHERE m.job_id = s.subject AND m.metric = 'report')  AS is_report,
  EXISTS(SELECT 1 FROM autonomy_metric_map m WHERE m.job_id = s.subject AND m.metric = 'intake')  AS is_intake,
  EXISTS(SELECT 1 FROM autonomy_metric_map m WHERE m.job_id = s.subject AND m.metric = 'improve') AS is_improve,
  w.start_utc AS window_start, w.end_utc AS window_end, w.window_source
FROM autonomy_subjects s
CROSS JOIN autonomy_window w
LEFT JOIN agent_ledger_current l ON l.job_id = s.subject
LEFT JOIN job_expected je ON je.job_id = s.subject;

-- 実行実体(job_id)単位の自律度。
--
-- NULL と 0 の区別(このビューで最も重要な約束):
--   NULL = 未測定。その項目の担当ではない / 窓内に予定実行が無い / スケジュールが不明。
--   0    = 担当で、予定実行もあったのに証跡が無い(= 本当に動いていない)。
-- 平均を取るときは AVG() が NULL を自動除外するので、未測定が平均を下げることはない。
--
-- 稼働日数バンド(①②③⑤): covered_days / expected_days の達成率。
--   0 = 証跡ゼロ / 1 = <30% / 2 = 30%以上 / 3 = 60%以上 / 4 = 80%以上 / 5 = 95%以上
--   expected_days は job_expected が窓ごとに解決するので、月次も週次も同じ土俵に乗る。
-- 追跡可能率バンド(④): traceable / events_total。0件=0 / <20%=1 / <50%=2 / <80%=3 / <100%=4 / 100%=5
-- 判断種別バンド(⑥): decision_kinds をそのまま 0〜5 に飽和させる(低頻度が本質なので日数では測らない)。
CREATE VIEW autonomy_v1 AS
SELECT
  b.subject,
  b.agent_id, b.role_ja, b.level, b.department, b.cron, b.cron_kind,
  b.ledger_registered, b.expected_basis,

  -- ①日報/報告
  CASE WHEN b.is_report = 0 OR b.expected_days IS NULL OR b.expected_days = 0 THEN NULL
       WHEN b.success_days = 0 THEN 0
       WHEN b.success_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.success_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.success_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.success_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m1_report,

  -- ②タスク実行(予定実行がある実体すべてに適用)
  CASE WHEN b.expected_days IS NULL OR b.expected_days = 0 THEN NULL
       WHEN b.exec_days = 0 THEN 0
       WHEN b.exec_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.exec_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.exec_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.exec_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m2_exec,

  -- ③情報収集
  CASE WHEN b.is_intake = 0 OR b.expected_days IS NULL OR b.expected_days = 0 THEN NULL
       WHEN b.success_days = 0 THEN 0
       WHEN b.success_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.success_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.success_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.success_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m3_intake,

  -- ④証跡記録。予定実行が無い窓では評価しない(未測定)が、証跡があるなら質は測れる。
  CASE WHEN b.events_total = 0 AND (b.expected_days IS NULL OR b.expected_days = 0) THEN NULL
       WHEN b.events_total = 0 THEN 0
       WHEN b.traceable_total = b.events_total THEN 5
       WHEN b.traceable_total * 100 >= 80 * b.events_total THEN 4
       WHEN b.traceable_total * 100 >= 50 * b.events_total THEN 3
       WHEN b.traceable_total * 100 >= 20 * b.events_total THEN 2
       ELSE 1 END AS m4_trace,

  -- ⑤自己改善
  CASE WHEN b.is_improve = 0 OR b.expected_days IS NULL OR b.expected_days = 0 THEN NULL
       WHEN b.success_days = 0 THEN 0
       WHEN b.success_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.success_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.success_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.success_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m5_improve,

  -- ⑥自律判断。予定実行が無い窓では判断の機会も無いので未測定にする。
  CASE WHEN b.expected_days IS NULL OR b.expected_days = 0 THEN NULL
       WHEN b.decision_kinds >= 5 THEN 5
       ELSE b.decision_kinds END AS m6_judge,

  -- 以下は点数の根拠(生の実測値)。点だけ見て判断させないために必ず並置する。
  b.expected_days, b.success_days, b.exec_days,
  b.events_total, b.success_total, b.failure_total, b.traceable_total, b.decision_kinds,
  b.window_start, b.window_end, b.window_source
FROM autonomy_base b;

-- 役職単位の期待値。1役職が複数ジョブを持つので、窓で解決した期待値を合計する。
CREATE VIEW autonomy_role_expected AS
SELECT l.agent_id, l.role_ja, l.level, l.department,
       COUNT(l.job_id) AS entity_count,                  -- 0 = 実行実体なし
       SUM(je.expected_days) AS expected_days            -- 実体なし・スケジュール不明なら NULL
FROM agent_ledger_current l
LEFT JOIN job_expected je ON je.job_id = l.job_id
GROUP BY l.agent_id, l.role_ja, l.level, l.department;

-- 役職単位の自律度。複数ジョブを持つ役職は「成功日の和集合 / 期待日数の合計」で評価する
-- (最も良いジョブの MAX を採ると甘くなるので採らない)。
-- entity_count=0(実行実体なし)や期待値0は 0 点ではなく NULL(未測定)。
CREATE VIEW autonomy_v1_by_role AS
SELECT
  re.agent_id, re.role_ja, re.level, re.department, re.entity_count, re.expected_days,
  s.success_days, s.events_total, s.decision_kinds,
  w.window_source,
  CASE WHEN re.entity_count = 0 OR re.expected_days IS NULL OR re.expected_days = 0 THEN NULL
       WHEN s.success_days = 0 THEN 0
       WHEN s.success_days * 100 >= 95 * re.expected_days THEN 5
       WHEN s.success_days * 100 >= 80 * re.expected_days THEN 4
       WHEN s.success_days * 100 >= 60 * re.expected_days THEN 3
       WHEN s.success_days * 100 >= 30 * re.expected_days THEN 2
       ELSE 1 END AS m_role_cadence
FROM autonomy_role_expected re
CROSS JOIN autonomy_window w
LEFT JOIN (
  SELECT l.agent_id,
         COUNT(DISTINCT CASE WHEN ev.result = 'success' THEN ev.jst_day END) AS success_days,
         COUNT(ev.id) AS events_total,
         COUNT(DISTINCT CASE WHEN ev.result = 'skip' THEN 'skip'
                             WHEN ev.action IN ('cron-unmapped','binding-drift','binding-report-stale',
                                                'deadline-approaching','deadline-overdue','porting-pending')
                             THEN ev.action END) AS decision_kinds
  FROM agent_ledger_current l
  JOIN autonomy_evidence ev ON ev.agent_id = l.job_id
  GROUP BY l.agent_id
) s ON s.agent_id = re.agent_id;

-- 組織サマリ。ダッシュボードはここを読む。
-- AVG() は NULL を自動的に除外するので、未測定が平均を押し下げることはない。
CREATE VIEW autonomy_org_summary AS
SELECT
  (SELECT window_start FROM autonomy_v1 LIMIT 1) AS window_start,
  (SELECT window_end   FROM autonomy_v1 LIMIT 1) AS window_end,
  (SELECT window_source FROM autonomy_window)    AS window_source,
  (SELECT COUNT(*) FROM agent_ledger_current)                                     AS ledger_rows,
  (SELECT COUNT(DISTINCT agent_id) FROM agent_ledger_current)                     AS roles_registered,
  (SELECT COUNT(DISTINCT agent_id) FROM agent_ledger_current WHERE job_id IS NOT NULL) AS roles_with_entity,
  (SELECT COUNT(DISTINCT agent_id) FROM agent_ledger_current WHERE agent_id NOT IN
     (SELECT agent_id FROM agent_ledger_current WHERE job_id IS NOT NULL))        AS roles_without_entity,
  (SELECT COUNT(*) FROM autonomy_v1)                                              AS subjects_total,
  (SELECT COUNT(*) FROM autonomy_v1 WHERE m2_exec IS NOT NULL)                    AS subjects_measured,
  (SELECT COUNT(*) FROM autonomy_v1 WHERE m2_exec IS NULL)                        AS subjects_unmeasured,
  (SELECT ROUND(AVG(m1_report), 2) FROM autonomy_v1)  AS avg_m1_report,
  (SELECT ROUND(AVG(m2_exec),   2) FROM autonomy_v1)  AS avg_m2_exec,
  (SELECT ROUND(AVG(m3_intake), 2) FROM autonomy_v1)  AS avg_m3_intake,
  (SELECT ROUND(AVG(m4_trace),  2) FROM autonomy_v1)  AS avg_m4_trace,
  (SELECT ROUND(AVG(m5_improve),2) FROM autonomy_v1)  AS avg_m5_improve,
  (SELECT ROUND(AVG(m6_judge),  2) FROM autonomy_v1)  AS avg_m6_judge,
  (SELECT COUNT(*) FROM autonomy_v1_by_role WHERE m_role_cadence IS NOT NULL)     AS roles_measured,
  (SELECT ROUND(AVG(m_role_cadence), 2) FROM autonomy_v1_by_role)                 AS avg_role_cadence;
