-- ⑥自律判断が未移植スタブを「自律的に判断した」と誤って評価していたのを直す。
--
-- 症状(2026-09-14 実測): tagtech-cron/daily-standup は m2_exec=0(何も実行していない)なのに
-- m6_judge=1 を獲得していた。同じ状態の実体が18件あり、組織平均 avg_m6_judge=0.3 を嵩上げしていた。
-- 未移植スタブは毎回同じ porting-pending を返すだけで、入力に応じて結果が変わらない。
-- それは判断ではなく定数なので、⑥に数えてはいけない。
--
-- 注意(ここを間違えると直らない): 「判断種別のリストから porting-pending を外す」だけでは
-- 1件も直らなかった。式が CASE WHEN result='skip' THEN 'skip' ELSE action END なので
-- result='skip' の分岐が先に当たり、記録される decision_kind は 'porting-pending' ではなく
-- 'skip' だったため。絞り込みも (result='skip' OR action IN (...)) なので IN リストから
-- 外しても result='skip' 側で拾われ続ける。**イベント単位で除外する**必要がある。
--
-- 採否の基準(RUNBOOK §6-1 に明文化): ⑥に数えてよいのは入力に応じて結果が変わりうる判断のみ。
-- 固定値を返すスタブ・未移植マーカー・定数レスポンスは対象外。
--
-- 変更は decision_kinds の算出のみ。バンドの閾値にも他の5項目にも触れない。
-- agent_ledger / events への DDL・DML は行わない(ビューの再定義だけ)。

DROP VIEW autonomy_v1_by_role;
DROP VIEW autonomy_base;

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
  -- ⑥自律判断の種類数。porting-pending(未移植マーカー)は判断ではないのでイベントごと除外する。
  -- 除外は result='skip' の分岐より前に効かせること(そうしないと 'skip' として数えられてしまう)。
  (SELECT COUNT(DISTINCT CASE WHEN ev.result = 'skip' THEN 'skip' ELSE ev.action END)
     FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject
      AND ev.action <> 'porting-pending'
      AND (ev.result = 'skip'
           OR ev.action IN ('cron-unmapped','binding-drift','binding-report-stale',
                            'deadline-approaching','deadline-overdue'))) AS decision_kinds,
  EXISTS(SELECT 1 FROM autonomy_metric_map m WHERE m.job_id = s.subject AND m.metric = 'report')  AS is_report,
  EXISTS(SELECT 1 FROM autonomy_metric_map m WHERE m.job_id = s.subject AND m.metric = 'intake')  AS is_intake,
  EXISTS(SELECT 1 FROM autonomy_metric_map m WHERE m.job_id = s.subject AND m.metric = 'improve') AS is_improve,
  w.start_utc AS window_start, w.end_utc AS window_end, w.window_source
FROM autonomy_subjects s
CROSS JOIN autonomy_window w
LEFT JOIN agent_ledger_current l ON l.job_id = s.subject
LEFT JOIN job_expected je ON je.job_id = s.subject;

-- 役職単位。実体単位と食い違わないよう、decision_kinds に同じ除外を入れる。
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
         COUNT(DISTINCT CASE WHEN ev.action = 'porting-pending' THEN NULL
                             WHEN ev.result = 'skip' THEN 'skip'
                             WHEN ev.action IN ('cron-unmapped','binding-drift','binding-report-stale',
                                                'deadline-approaching','deadline-overdue')
                             THEN ev.action END) AS decision_kinds
  FROM agent_ledger_current l
  JOIN autonomy_evidence ev ON ev.agent_id = l.job_id
  GROUP BY l.agent_id
) s ON s.agent_id = re.agent_id;
