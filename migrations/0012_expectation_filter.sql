-- 実体判定ガード(meta.expectation)の結果を自律度の計測に取り込む。
--
-- 背景: tagtech-automation の一部タスクが業務をせず「やり方の解説文」を生成していた
-- (hn_trends_morning は HN 記事一覧ではなく「HN→Discord ボットの作り方」、
--  cfo_finance_report は収支ではなく「実装サンプル」)。原因は cronToTasks の指示文を
-- そのまま LLM に渡していることで、LLM は外部 API を叩けないため「作り方」を答える。
-- 結果として「実体のない success」が証跡に残り、①②③⑤の分子を汚していた。
--
-- 証跡層側のガード(別セッション実装・本番デプロイ済み)は、送信側が expect を宣言すると
-- 受信側が機械判定(LLM 不使用・正規表現とカウントのみ)し、結果を meta.expectation に併記する。
-- result は書き換えない(events は追記専用で、送信側の申告はそのまま残す)。
--
-- 本 migration はその判定結果を計測側で尊重する。
--
-- 除外の範囲(意図的に狭くしている):
--   ①③⑤の success_days と ②の exec_days の分子から ok=0 を除外する
--   ④ m4_trace には適用しない。実体が無くても「証跡としてきちんと記録された」ことは事実で、
--     記録の質の指標を汚さない
--   ⑥は 0011 で別途対処済み。二重に適用しない
--
-- 未判定の扱い: meta が NULL / expectation キーが無いイベントは**従来どおり数える**。
-- ガードは opt-in 設計(expect 未指定の送信元は無改造で動く)なので、未判定を除外すると
-- 「検査していない」と「検査して実体が無かった」が混ざる。NULL=未測定 / 0=実体なし という
-- 既存の規律とも一貫させる。
--
-- json_extract は JSON の false に対して整数 0 を返す(本番データで確認済み)。
-- 将来 "ok" を文字列 "false" で書く経路ができると = 0 では拾えないので、boolean を保つこと。
--
-- **この除外は対症療法である。** 根治は cronToTasks の指示文の書き直しであり別作業。

DROP VIEW autonomy_org_summary;
DROP VIEW autonomy_v1_by_role;
DROP VIEW autonomy_v1;
DROP VIEW autonomy_base;

CREATE VIEW autonomy_base AS
SELECT
  s.subject,
  l.agent_id, l.role_ja, l.level, l.department,
  je.cron, je.cron_kind,
  CASE WHEN l.job_id IS NULL THEN 0 ELSE 1 END AS ledger_registered,
  je.expected_days AS expected_days,
  CASE WHEN je.job_id IS NULL THEN 'unknown' ELSE 'schedule' END AS expected_basis,
  (SELECT COUNT(*) FROM autonomy_evidence ev WHERE ev.agent_id = s.subject) AS events_total,
  (SELECT COUNT(*) FROM autonomy_evidence ev WHERE ev.agent_id = s.subject AND ev.result = 'success') AS success_total,
  (SELECT COUNT(*) FROM autonomy_evidence ev WHERE ev.agent_id = s.subject AND ev.result = 'failure') AS failure_total,
  -- 実体なしと判定された証跡の件数。静かに除外すると偽陽性の規模が見えなくなるので必ず出す。
  (SELECT COUNT(*) FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject
      AND json_extract(ev.meta,'$.expectation.ok') = 0) AS unsubstantiated_total,
  -- ①③⑤の分子。実体なしと判定された success は数えない。
  (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject AND ev.result = 'success'
      AND (json_extract(ev.meta,'$.expectation.ok') IS NULL
           OR json_extract(ev.meta,'$.expectation.ok') <> 0)) AS success_days,
  -- ②の分子。同上。
  (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject AND ev.result = 'success'
      AND ev.action IN ('run','scheduled','deploy')
      AND (json_extract(ev.meta,'$.expectation.ok') IS NULL
           OR json_extract(ev.meta,'$.expectation.ok') <> 0)) AS exec_days,
  -- ④は実体の有無で減点しない(記録されたこと自体を評価する指標のため)。
  (SELECT COUNT(*) FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject AND (ev.evidence_url IS NOT NULL OR ev.meta LIKE '{%')) AS traceable_total,
  -- ⑥は 0011 の定義のまま。porting-pending(未移植マーカー)はイベントごと除外する。
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

CREATE VIEW autonomy_v1 AS
SELECT
  b.subject,
  b.agent_id, b.role_ja, b.level, b.department, b.cron, b.cron_kind,
  b.ledger_registered, b.expected_basis,

  CASE WHEN b.is_report = 0 OR b.expected_days IS NULL OR b.expected_days = 0 THEN NULL
       WHEN b.success_days = 0 THEN 0
       WHEN b.success_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.success_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.success_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.success_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m1_report,

  CASE WHEN b.expected_days IS NULL OR b.expected_days = 0 THEN NULL
       WHEN b.exec_days = 0 THEN 0
       WHEN b.exec_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.exec_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.exec_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.exec_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m2_exec,

  CASE WHEN b.is_intake = 0 OR b.expected_days IS NULL OR b.expected_days = 0 THEN NULL
       WHEN b.success_days = 0 THEN 0
       WHEN b.success_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.success_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.success_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.success_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m3_intake,

  CASE WHEN b.events_total = 0 AND (b.expected_days IS NULL OR b.expected_days = 0) THEN NULL
       WHEN b.events_total = 0 THEN 0
       WHEN b.traceable_total = b.events_total THEN 5
       WHEN b.traceable_total * 100 >= 80 * b.events_total THEN 4
       WHEN b.traceable_total * 100 >= 50 * b.events_total THEN 3
       WHEN b.traceable_total * 100 >= 20 * b.events_total THEN 2
       ELSE 1 END AS m4_trace,

  CASE WHEN b.is_improve = 0 OR b.expected_days IS NULL OR b.expected_days = 0 THEN NULL
       WHEN b.success_days = 0 THEN 0
       WHEN b.success_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.success_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.success_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.success_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m5_improve,

  CASE WHEN b.expected_days IS NULL OR b.expected_days = 0 THEN NULL
       WHEN b.decision_kinds >= 5 THEN 5
       ELSE b.decision_kinds END AS m6_judge,

  b.expected_days, b.success_days, b.exec_days,
  b.events_total, b.success_total, b.failure_total, b.traceable_total, b.decision_kinds,
  b.unsubstantiated_total,
  b.window_start, b.window_end, b.window_source
FROM autonomy_base b;

-- 役職単位も同じ除外を入れる。片方だけだと実体単位と役職単位で食い違う(0011 と同じ理由)。
CREATE VIEW autonomy_v1_by_role AS
SELECT
  re.agent_id, re.role_ja, re.level, re.department, re.entity_count, re.expected_days,
  s.success_days, s.events_total, s.decision_kinds, s.unsubstantiated_total,
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
         COUNT(DISTINCT CASE WHEN ev.result = 'success'
                              AND (json_extract(ev.meta,'$.expectation.ok') IS NULL
                                   OR json_extract(ev.meta,'$.expectation.ok') <> 0)
                             THEN ev.jst_day END) AS success_days,
         COUNT(ev.id) AS events_total,
         SUM(CASE WHEN json_extract(ev.meta,'$.expectation.ok') = 0 THEN 1 ELSE 0 END) AS unsubstantiated_total,
         COUNT(DISTINCT CASE WHEN ev.action = 'porting-pending' THEN NULL
                             WHEN ev.result = 'skip' THEN 'skip'
                             WHEN ev.action IN ('cron-unmapped','binding-drift','binding-report-stale',
                                                'deadline-approaching','deadline-overdue')
                             THEN ev.action END) AS decision_kinds
  FROM agent_ledger_current l
  JOIN autonomy_evidence ev ON ev.agent_id = l.job_id
  GROUP BY l.agent_id
) s ON s.agent_id = re.agent_id;

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
  -- 除外の規模。0 のまま増えないなら「送信元がまだ expect を宣言していない」ことを意味する。
  (SELECT COUNT(*) FROM autonomy_evidence ev
     WHERE json_extract(ev.meta,'$.expectation.ok') = 0)                          AS events_unsubstantiated,
  (SELECT COUNT(*) FROM autonomy_v1 WHERE unsubstantiated_total > 0)              AS subjects_with_unsubstantiated,
  (SELECT ROUND(AVG(m1_report), 2) FROM autonomy_v1)  AS avg_m1_report,
  (SELECT ROUND(AVG(m2_exec),   2) FROM autonomy_v1)  AS avg_m2_exec,
  (SELECT ROUND(AVG(m3_intake), 2) FROM autonomy_v1)  AS avg_m3_intake,
  (SELECT ROUND(AVG(m4_trace),  2) FROM autonomy_v1)  AS avg_m4_trace,
  (SELECT ROUND(AVG(m5_improve),2) FROM autonomy_v1)  AS avg_m5_improve,
  (SELECT ROUND(AVG(m6_judge),  2) FROM autonomy_v1)  AS avg_m6_judge,
  (SELECT COUNT(*) FROM autonomy_v1_by_role WHERE m_role_cadence IS NOT NULL)     AS roles_measured,
  (SELECT ROUND(AVG(m_role_cadence), 2) FROM autonomy_v1_by_role)                 AS avg_role_cadence;
