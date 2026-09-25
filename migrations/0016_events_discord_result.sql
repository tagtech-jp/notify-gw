-- 非破壊マイグレーション: 既存の events テーブルへ列を2つ追加するだけ。
-- ALTER TABLE ADD COLUMN のみで、UPDATE / DELETE / 型変更は一切行わない。
-- NOT NULL 制約・DEFAULT 句を付けないため、既存行は両列とも NULL のまま変化しない。
-- 適用順序(RUNBOOK §8-1-d 参照): 本番適用 → 列の存在を読み戻し確認 → その後にコード側PRをマージする。
-- 列が無い状態でコードが先にデプロイされると INSERT/UPDATE が失敗し証跡が消えるため、順序を厳守する。
--
-- discord_sent   : CRITICAL の #alerts 送信を試みた結果。成功=1 / 失敗=0。
--                  送信を試みていない行(WARN/INFO、または #alerts 到達判定の対象外)は NULL のまま。
-- discord_status : 送信時に得られた HTTP ステータス。取得できなかった場合は NULL。
--
-- 判断2(2026-09-22 社長承認): discord_sent が events に保存されておらず、#alerts への到達を
-- 証跡から判定できなかったため追加する。日報の「#alerts送信失敗: N件」と、
-- 未解消 CRITICAL の持ち越し表示(#alerts未達マーカー)の集計元になる。

ALTER TABLE events ADD COLUMN discord_sent INTEGER;
ALTER TABLE events ADD COLUMN discord_status INTEGER;
