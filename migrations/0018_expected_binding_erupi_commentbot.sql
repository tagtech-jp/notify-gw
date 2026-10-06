-- erupi-commentbot(whowatch のえるぴの配信へ速報・曲名などを流すコメントボット・PC 上の常駐)を死活監視の対象に加える
-- (2026-10-07 社長指示)。Worker ではないのでバインディングは持たない(0017 の fuwacchi-feed と同じ形)。
-- 常駐が5分ごとに POST /heartbeat を送り、vars.FAST_LIVENESS の erupi-commentbot:15 で、15分届かなければ #alerts に知らせる。
-- 2026-10-06 22:21〜22:25 にボットが止まった(配信中にコメントが約4分半止まった)が、ボットの中のログにしか残らず誰も気づけなかった。
INSERT INTO expected_bindings (agent_id, bindings, note) VALUES
  ('erupi-commentbot', '[]', 'PC常駐のコメントボット(erupi-commentbot)。バインディング無し。5分毎ハートビートの途絶のみ監視する');
