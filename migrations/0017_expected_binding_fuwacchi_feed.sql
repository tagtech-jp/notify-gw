-- fuwacchi-feed(whowatch 配信の自動収録・PC 上の常駐 record:watch)を死活監視の対象に加える(2026-10-04 社長指示)。
-- Worker ではないのでバインディングは持たない(0003 の vault-sync と同じ形)。常駐が1時間ごとに POST /heartbeat を送り、
-- 26時間途絶すると日報に出る。PC が止まる・常駐が落ちる・ネットが切れると配信を収録できないが、PC の中からは気づけない。
INSERT INTO expected_bindings (agent_id, bindings, note) VALUES
  ('fuwacchi-feed', '[]', 'PC常駐の配信収録(record:watch)。バインディング無し。1時間毎ハートビートの途絶のみ監視する');
