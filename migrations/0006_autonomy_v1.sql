-- 自律度の実測ビュー autonomy_v1。
--
-- 設計原則:
--   1. LLM を一切使わない。events(証跡)だけから決定論的に算出する。
--   2. 点数の隣に必ず生の実測値(日数・件数・期待値)を並置し、SQL 1本で根拠を追えるようにする。
--   3. 「対象外」と「0点」を区別する。NULL = その項目の担当ではない / 0 = 担当だが証跡ゼロ。
--   4. 恣意的な分類を SQL に埋め込まない。report/intake/improve の該当判定は
--      autonomy_metric_map(人がレビューする data/autonomy_metric_rules.json 由来)に委ねる。
--   5. 定義を変えるときはこのビューを書き換えず autonomy_v2 を作る(過去の点数の再現性を守る)。

-- 集計窓: 直近28 JST日。当日は不完全なので除外し、前日までの28日を見る。
-- JST日D の 00:00 = UTC (D-1) 15:00 (既存 src/lib/jst.ts・RUNBOOK §3 の規約と同じ)。
-- 境界リテラルは events.ts(toISOString のミリ秒つき)と辞書順比較が一致するよう '.000Z' 形式で持つ。
CREATE VIEW autonomy_window AS
SELECT strftime('%Y-%m-%dT15:00:00.000Z', date('now','+9 hours','-29 days')) AS start_utc,
       strftime('%Y-%m-%dT15:00:00.000Z', date('now','+9 hours','-1 day'))   AS end_utc;

-- 窓内の証跡に JST 日付を付けたもの。以降の集計はすべてこれを通す。
CREATE VIEW autonomy_evidence AS
SELECT e.id, e.agent_id, e.action, e.result, e.severity, e.evidence_url, e.meta,
       date(e.ts, '+9 hours') AS jst_day
FROM events e, autonomy_window w
WHERE e.ts >= w.start_utc AND e.ts < w.end_utc;

-- 評価対象: 台帳に実体がある job_id ∪ 窓内に証跡を出した agent_id。
-- 後者を含めるのは「台帳に無いのに動いている実体」(例: tagtech-cron の各ジョブ)を隠さないため。
CREATE VIEW autonomy_subjects AS
SELECT job_id AS subject FROM agent_ledger_current WHERE job_id IS NOT NULL
UNION
SELECT agent_id AS subject FROM autonomy_evidence;

-- 生の実測値。点数化の前段。
CREATE VIEW autonomy_base AS
SELECT
  s.subject,
  l.agent_id, l.role_ja, l.level, l.department, l.cron,
  CASE WHEN l.job_id IS NULL THEN 0 ELSE 1 END AS ledger_registered,
  -- 期待稼働日数。台帳未登録の実体は宣言が無いので日次(28)と仮定する(ledger_registered=0 で判別可能)。
  max(COALESCE(l.expected_days_28d, 28), 1) AS expected_days,
  (SELECT COUNT(*) FROM autonomy_evidence ev WHERE ev.agent_id = s.subject) AS events_total,
  (SELECT COUNT(*) FROM autonomy_evidence ev WHERE ev.agent_id = s.subject AND ev.result = 'success') AS success_total,
  (SELECT COUNT(*) FROM autonomy_evidence ev WHERE ev.agent_id = s.subject AND ev.result = 'failure') AS failure_total,
  -- 成功証跡があった JST 日数。①③⑤はこれを期待稼働日数で正規化する。
  (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject AND ev.result = 'success') AS success_days,
  -- ②タスク実行だけは「定時実行そのもの」を見るので action を限定する。
  (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject AND ev.result = 'success'
      AND ev.action IN ('run','scheduled','deploy')) AS exec_days,
  -- ④証跡記録: 追跡可能(evidence_url がある or meta に JSON が入っている)な証跡の件数。
  (SELECT COUNT(*) FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject AND (ev.evidence_url IS NOT NULL OR ev.meta LIKE '{%')) AS traceable_total,
  -- ⑥自律判断: 人に指示されず自分で下した判断の「種類数」。
  --   result='skip'          = 実行すべきでないと自分で判断して見送った
  --   cron-unmapped 等        = 自分で異常・期限・整合性の破れを検知して記録した
  -- 低頻度が本質なので日数バンドではなく種類数で評価する(健全な月は0になり得る。下記の限界1参照)。
  (SELECT COUNT(DISTINCT CASE WHEN ev.result = 'skip' THEN 'skip' ELSE ev.action END)
     FROM autonomy_evidence ev
    WHERE ev.agent_id = s.subject
      AND (ev.result = 'skip'
           OR ev.action IN ('cron-unmapped','binding-drift','binding-report-stale',
                            'deadline-approaching','deadline-overdue','porting-pending'))) AS decision_kinds,
  -- 該当判定(担当かどうか)。担当でない項目は点数を NULL にして「対象外」を明示する。
  EXISTS(SELECT 1 FROM autonomy_metric_map m WHERE m.job_id = s.subject AND m.metric = 'report')  AS is_report,
  EXISTS(SELECT 1 FROM autonomy_metric_map m WHERE m.job_id = s.subject AND m.metric = 'intake')  AS is_intake,
  EXISTS(SELECT 1 FROM autonomy_metric_map m WHERE m.job_id = s.subject AND m.metric = 'improve') AS is_improve,
  w.start_utc AS window_start, w.end_utc AS window_end
FROM autonomy_subjects s
CROSS JOIN autonomy_window w
LEFT JOIN agent_ledger_current l ON l.job_id = s.subject;

-- 実行実体(job_id)単位の自律度。
--
-- 稼働日数バンド(①②③⑤): covered_days / expected_days の達成率を 0〜5 に落とす。
--   0 = 証跡ゼロ / 1 = <30% / 2 = 30%以上 / 3 = 60%以上 / 4 = 80%以上 / 5 = 95%以上
--   cron の期待値で割るので、週次ジョブ(28日=4週なので期待4日)が日次ジョブと同じ基準で並ぶ。
--   28日 = ちょうど4週のため曜日指定 cron の期待値は暦に依存しない(日付指定 cron のみ±1揺れる)。
-- 追跡可能率バンド(④): traceable / events_total。0件=0 / <20%=1 / <50%=2 / <80%=3 / <100%=4 / 100%=5
-- 判断種別バンド(⑥): decision_kinds をそのまま 0〜5 に飽和させる(5種類以上で5)。
CREATE VIEW autonomy_v1 AS
SELECT
  b.subject,
  b.agent_id, b.role_ja, b.level, b.department, b.cron, b.ledger_registered,

  -- ①日報/報告
  CASE WHEN b.is_report = 0 THEN NULL
       WHEN b.success_days = 0 THEN 0
       WHEN b.success_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.success_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.success_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.success_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m1_report,

  -- ②タスク実行(cron を持つ実体すべてに適用。autonomy_metric_map の exec 行は主目的の記録であり算出には使わない)
  CASE WHEN b.exec_days = 0 THEN 0
       WHEN b.exec_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.exec_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.exec_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.exec_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m2_exec,

  -- ③情報収集
  CASE WHEN b.is_intake = 0 THEN NULL
       WHEN b.success_days = 0 THEN 0
       WHEN b.success_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.success_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.success_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.success_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m3_intake,

  -- ④証跡記録
  CASE WHEN b.events_total = 0 THEN 0
       WHEN b.traceable_total = b.events_total THEN 5
       WHEN b.traceable_total * 100 >= 80 * b.events_total THEN 4
       WHEN b.traceable_total * 100 >= 50 * b.events_total THEN 3
       WHEN b.traceable_total * 100 >= 20 * b.events_total THEN 2
       ELSE 1 END AS m4_trace,

  -- ⑤自己改善
  CASE WHEN b.is_improve = 0 THEN NULL
       WHEN b.success_days = 0 THEN 0
       WHEN b.success_days * 100 >= 95 * b.expected_days THEN 5
       WHEN b.success_days * 100 >= 80 * b.expected_days THEN 4
       WHEN b.success_days * 100 >= 60 * b.expected_days THEN 3
       WHEN b.success_days * 100 >= 30 * b.expected_days THEN 2
       ELSE 1 END AS m5_improve,

  -- ⑥自律判断
  CASE WHEN b.decision_kinds >= 5 THEN 5 ELSE b.decision_kinds END AS m6_judge,

  -- 以下は点数の根拠(生の実測値)。点だけ見て判断させないために必ず並置する。
  b.expected_days, b.success_days, b.exec_days,
  b.events_total, b.success_total, b.failure_total, b.traceable_total, b.decision_kinds,
  b.window_start, b.window_end
FROM autonomy_base b;

-- 役職単位の期待値。1役職が複数ジョブを持つので期待日数は合計する。
CREATE VIEW autonomy_role_expected AS
SELECT agent_id, role_ja, level, department,
       COUNT(job_id) AS entity_count,                       -- 0 = 実行実体なし
       max(COALESCE(SUM(expected_days_28d), 0), 1) AS expected_days
FROM agent_ledger_current
GROUP BY agent_id, role_ja, level, department;

-- 役職単位の自律度。複数ジョブを持つ役職は「成功日の和集合 / 期待日数の合計」で評価する。
-- (最も良いジョブの MAX を採ると甘くなるので採らない)
CREATE VIEW autonomy_v1_by_role AS
SELECT
  re.agent_id, re.role_ja, re.level, re.department, re.entity_count, re.expected_days,

  -- 役職としての稼働率バンド。entity_count=0(実行実体なし)は 0 点。
  CASE WHEN re.entity_count = 0 THEN 0
       WHEN (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
              WHERE ev.result = 'success' AND ev.agent_id IN
                (SELECT l.job_id FROM agent_ledger_current l
                  WHERE l.agent_id = re.agent_id AND l.job_id IS NOT NULL)) = 0 THEN 0
       WHEN (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
              WHERE ev.result = 'success' AND ev.agent_id IN
                (SELECT l.job_id FROM agent_ledger_current l
                  WHERE l.agent_id = re.agent_id AND l.job_id IS NOT NULL)) * 100
            >= 95 * re.expected_days THEN 5
       WHEN (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
              WHERE ev.result = 'success' AND ev.agent_id IN
                (SELECT l.job_id FROM agent_ledger_current l
                  WHERE l.agent_id = re.agent_id AND l.job_id IS NOT NULL)) * 100
            >= 80 * re.expected_days THEN 4
       WHEN (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
              WHERE ev.result = 'success' AND ev.agent_id IN
                (SELECT l.job_id FROM agent_ledger_current l
                  WHERE l.agent_id = re.agent_id AND l.job_id IS NOT NULL)) * 100
            >= 60 * re.expected_days THEN 3
       WHEN (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
              WHERE ev.result = 'success' AND ev.agent_id IN
                (SELECT l.job_id FROM agent_ledger_current l
                  WHERE l.agent_id = re.agent_id AND l.job_id IS NOT NULL)) * 100
            >= 30 * re.expected_days THEN 2
       ELSE 1 END AS m_role_cadence,

  -- 成功日の和集合(役職として1日に1回以上成功した日数)
  (SELECT COUNT(DISTINCT ev.jst_day) FROM autonomy_evidence ev
    WHERE ev.result = 'success' AND ev.agent_id IN
      (SELECT l.job_id FROM agent_ledger_current l
        WHERE l.agent_id = re.agent_id AND l.job_id IS NOT NULL)) AS success_days,

  (SELECT COUNT(*) FROM autonomy_evidence ev
    WHERE ev.agent_id IN (SELECT l.job_id FROM agent_ledger_current l
                           WHERE l.agent_id = re.agent_id AND l.job_id IS NOT NULL)) AS events_total,

  (SELECT COUNT(DISTINCT CASE WHEN ev.result = 'skip' THEN 'skip' ELSE ev.action END)
     FROM autonomy_evidence ev
    WHERE ev.agent_id IN (SELECT l.job_id FROM agent_ledger_current l
                           WHERE l.agent_id = re.agent_id AND l.job_id IS NOT NULL)
      AND (ev.result = 'skip'
           OR ev.action IN ('cron-unmapped','binding-drift','binding-report-stale',
                            'deadline-approaching','deadline-overdue','porting-pending'))) AS decision_kinds
FROM autonomy_role_expected re;
