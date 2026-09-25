-- vault-sync-loop.sh は Worker ではなく WSL 上の常駐ループなのでバインディングを持たない。
-- binding_reports を「最終生存確認」の台帳として流用し、1時間毎のハートビートで更新する。
-- 26時間途絶で日報に WARN として出る(2026-09-09 16:50〜09-14 の 4.5 日停止が誰にも気づかれなかった再発防止)。
INSERT INTO expected_bindings (agent_id, bindings, note) VALUES
  ('vault-sync', '[]', 'WSL常駐ループ。バインディング無し。1時間毎ハートビートの途絶のみ監視する');
