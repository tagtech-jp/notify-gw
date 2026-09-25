# notify-gw 運用 Runbook

対象: 通知ゲートウェイ兼証跡層 Worker `notify-gw`（`https://notify-gw.bb25xp.workers.dev`）と、
その外部死活監視を担う `tagtech-cron` の watchdog（heartbeat / digest-watch）。

## 1. 構成の要点

| 要素 | 実体 |
|---|---|
| 証跡 DB | D1 `notify-gw`（binding `NOTIFY_DB`）。`events` は追記専用。UPDATE/DELETE しない |
| 即時通知 | severity=CRITICAL のみ `#alerts`（メンション付き）。同一 fingerprint は 30 分抑制 |
| 日報 | cron `5 0 * * *`（JST 09:05）に前日分を SQL 集計 → `#digest`。LLM 不使用 |
| 死活監視 | tagtech-cron 09:05 heartbeat（`/health`）、10:00 digest-watch（`/digest/status`）。異常時のみ旧来 Webhook 直送で `#alerts` |
| Worker 間通信 | 必ず Service Binding。workers.dev への fetch は error 1042 で拒否される |

## 2. 障害時の手順

### 2-1. `#alerts` に「🚨 notify-gw 死亡疑い」が来た
1. `curl -s -H "X-Run-Key: $(cat .run-key.txt)" https://notify-gw.bb25xp.workers.dev/health`
   - `{"ok":true,...}` なら Worker 自体は生きている。tagtech-cron 側の `NOTIFY_GW_KEY` 不一致や Service Binding 設定を疑う（`wrangler tail tagtech-cron` で `status:` を確認）
   - 503 / 応答なしなら D1 か Worker の障害。`wrangler tail notify-gw` と Cloudflare ダッシュボードの D1 状態を確認
2. 復旧後は次回 heartbeat（翌 09:05）で自動的に沈黙に戻る。手動確認は `tagtech-cron /?job=heartbeat`

### 2-2. `#alerts` に「🚨 日報未達」が来た / 09:05 に `#digest` が届かない
1. `GET /digest/status?date=YYYY-MM-DD` で `digest_log` を確認（`sent`, `discord_ok`）
2. `discord_ok=0` なら Discord 側の失敗。`events` の `agent_id='notify-gw' AND action='digest-send'` の `meta` にエラーが残る
3. 手動再送: `curl -X POST -H "X-Run-Key: ..." https://notify-gw.bb25xp.workers.dev/digest/run`（前日分を再生成して送信。`digest_log` は upsert）

### 2-3. 証跡が D1 に入らない（送信元側）
- 送信元の `wrangler tail` で `notify-gw /event 失敗: HTTP 403` → `NOTIFY_GW_KEY` が notify-gw の `RUN_KEY` と不一致。`.run-key.txt` の値を `wrangler secret put NOTIFY_GW_KEY` で再投入
- `error code: 1042` → workers.dev 経由で fetch している。Service Binding に直す

## 2-4. エージェント台帳はどれを見るか

| テーブル | 用途 | 状態 |
|---|---|---|
| **`agent_ledger`** | **役職(69名)と実行実体(Worker/cron)の突合台帳。追記専用** | **これを使う**（`0004`〜`0006`） |
| `agents` | 初期設計の台帳（0001_init.sql） | **非推奨**。参照・書き込みを新規に追加しない。削除もしない |
| `expected_bindings` / `binding_reports` | バインディングの期待値と最終申告（死活監視） | 現役 |

`agents` を非推奨にした理由は `migrations/0008_deprecate_agents_table.sql` と `_deprecations` テーブルに記録してあります。
要点は「`agent_id` が PRIMARY KEY のため 1 役職＝複数実行実体を表現できない」「訂正を追記で行う思想に合わない」「台帳を 2 つ持つと実態との乖離を自分で作る」の 3 点です。

`agent_ledger.job_id` は `events.agent_id` と完全一致する突合キーです。台帳と実測の差分はこの SQL で取れます:

```sql
-- 証跡はあるが台帳に無い(= 台帳への追加が必要)
SELECT e.agent_id, COUNT(*) n FROM events e
 WHERE e.ts >= datetime('now','-7 day')
   AND e.agent_id NOT IN (SELECT job_id FROM agent_ledger WHERE job_id IS NOT NULL)
 GROUP BY 1 ORDER BY n DESC;

-- 台帳にあるが証跡が無い(= 週次/月次なら正常。expected_days_28d と併せて見る)
SELECT l.job_id FROM agent_ledger l
 WHERE l.job_id IS NOT NULL AND l.active = 1
   AND l.job_id NOT IN (SELECT DISTINCT agent_id FROM events WHERE ts >= datetime('now','-7 day'));
```

## 3. 手動照会 SQL（`npx wrangler d1 execute notify-gw --remote --command "..."`）

```sql
-- 直近 24 時間の件数（agent × severity）
SELECT agent_id, severity, COUNT(*) FROM events
 WHERE ts >= datetime('now','-1 day') GROUP BY 1,2 ORDER BY 1,2;

-- 特定日(JST)の CRITICAL 一覧。JST の 1 日 = UTC 前日 15:00 〜 当日 15:00
SELECT id, ts, agent_id, action, target FROM events
 WHERE ts >= '2026-09-10T15:00:00Z' AND ts < '2026-09-11T15:00:00Z' AND severity='CRITICAL' ORDER BY id;

-- 同一 fingerprint の再発回数
SELECT fingerprint, agent_id, action, COUNT(*) n, MIN(ts), MAX(ts) FROM events
 GROUP BY fingerprint HAVING n > 1 ORDER BY n DESC;

-- 日報の送信履歴
SELECT * FROM digest_log ORDER BY date_jst DESC LIMIT 14;
```

## 4. シークレット

| Worker | 名前 | 用途 |
|---|---|---|
| notify-gw | `RUN_KEY` | 全エンドポイントの X-Run-Key。ローカル控え `.run-key.txt`（gitignore） |
| notify-gw | `DISCORD_WEBHOOK_ALERTS` / `DISCORD_WEBHOOK_DIGEST` / `MENTION_USER_ID` | 通知先。ファイル・コミットには置かない |
| tagtech-cron / vault-intel | `NOTIFY_GW_KEY` | notify-gw の `RUN_KEY` と同じ値 |
| tagtech-cron | `DISCORD_WEBHOOK_ALERTS` | watchdog フォールバック直送用 |

投入は必ず `printf '%s' "$VALUE" | npx wrangler secret put NAME`（投入前に `wc -c` で文字数確認）。
`RUN_KEY` をローテーションしたら、送信元すべての `NOTIFY_GW_KEY` も同時に更新すること。

**対話プロンプトで投入するときは、アスタリスク（`*****`）が表示されることを確認してから Enter を押す。
表示されなければ貼り付けが効いておらず、空文字が登録される。`✨ Success!` は空文字でも出る。**
実例（2026-09-19〜21・tagtech-cron）: `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` の3本が
空文字で登録されていた。`wrangler secret list` には名前が出る、`wrangler versions view` にも束縛として出る、
デプロイも通る——**名前が在ることと値が在ることは別**で、名前しか見えない手段では検知できない。
発覚は `cto-tech-monitor` の dry-run が `missing_credential:GEMINI_API_KEY` を返したことによる
（コードは `if (!key)` で空文字も「無い」と扱う）。09-21 に再投入し、プロンプトのアスタリスクを目視確認して解消。

**投入直後の確認手順（名前ではなく「値が効いているか」を見る）:**

| 対象 | 確認方法 | 空値のときの見え方 |
|---|---|---|
| tagtech-cron のモデル照合用鍵（`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENAI_API_KEY`） | `GET /?job=cto-tech-monitor&dry=1`（送信なし・§8-1 手順2） | `[判定不能] … missing_credential:<名前>`。全提供元が `[OK]` / `[deprecated]` / `[missing]` のいずれかで判定できていれば値は効いている |
| `NOTION_*_DB_ID` / `NOTION_API_KEY` / `GITHUB_LIVENESS_TOKEN` | 同上 | 疎通確認が `HTTP 401/404` や `unverifiable` になる |
| `NOTIFY_GW_KEY`（送信元） | 送信元の `/?job=heartbeat` → notify-gw の `events` に行が増える | notify-gw 側 `403`、`events` に増えない |
| notify-gw の `RUN_KEY` | `curl -H "X-Run-Key: $(cat .run-key.txt)" /health` | 403 |

投入に「成功した」と報告するときは、`secret list` の名前ではなく**この確認の結果**を添える。

### 4-2. 鍵ファイル（`.run-key.txt`）の作成と読み取り

**作成**: 末尾に改行も CR も入れない。

```bash
printf '%s' "$KEY" > .run-key.txt     # echo は改行を付けるので使わない
xxd .run-key.txt | tail -1            # 末尾バイトを目視。0a / 0d で終わっていたら作り直す
wc -c < .run-key.txt                  # 長さも確認（RUN_KEY は 48 バイト）
```

**読み取り**: `$(cat file)` は**末尾の LF は削るが CR は残す**。
HTTP ヘッダに載せる分には偶然通ってしまうが、`gh secret set` のように
**素のバイト列を扱う経路では壊れる**。値を別の場所へ渡すときは必ず CR を落とす。

```bash
K=$(tr -d '\r\n' < .run-key.txt)      # 渡す用。値は画面に出さない
[ ${#K} -eq 48 ] || { echo "ABORT: ${#K} 文字"; exit 1; }   # 長さを assert してから使う
printf '%s' "$K" | gh secret set NOTIFY_GW_KEY -R nikkun22/<repo>
```

**Windows で作ったファイルには CR が入り得る。** エディタ・PowerShell の
リダイレクト・`git` の `core.autocrlf` のいずれでも混入する。
**bash 側で読むときは、まず末尾バイトを見る**（§7-1 実例6）。

実績（2026-09-21 の全数調査）: `.run-key.txt` 4本のうち **2本に CR が混入**していた
（`projects/notify-gw`・`cloudflare/vault-intel` が 49 バイト / 末尾 `0d`。
`cloudflare/tagtech-cron`・`cloudflare/growth-collector` は 48 バイトで正常）。
除去後、誤鍵 403 / 正鍵 200 を各 Worker で読み戻して確認した。

### 4-1. 認証・トークンの失効履歴

事実のみを記録する。原本（インシデント記録・SOP）は消さず、ここはリンクで参照する。重複記載しない。

| 日付 | 対象 | 症状（エラーコード） | 根本原因 | 復旧手順 | 有効期限 |
|---|---|---|---|---|---|
| 2026-05-13 | Discord MCP | HTTP 401 | `Authorization` ヘッダに `Bot ` プレフィックスが無かった（**期限切れではない**） | `docs/incidents/discord_mcp_401_recovery_20260513.md`（tagtech） | 該当なし |
| 2026-05-26 | Notion API / MCP | HTTP 401（4回連続） | トークンの無効化。Regenerate すると旧トークンは即時失効する | `docs/ops/notion_reauth_procedure.md`（tagtech） | 不明（手順書に記載なし） |
| 2026-09-12 | `CLOUDFLARE_API_TOKEN`（GitHub Actions Secret） | `Invalid access token [code: 9109]` | トークン無効。2026-05-16〜09-12 の約4ヶ月、CI デプロイが全失敗していた（本番は 5/22 のローカル deploy 版のまま） | `docs/ops/cloudflare_api_token_sop_v1.md`（tagtech） | 不明（`expires_on` 未記録） |
| 2026-09-18 | wrangler のローカル OAuth 認証 | `wrangler d1 execute --remote` が `code 7403` で拒否 | OAuth 認証の失効。記録は本節が初出 | `npx wrangler login`（ブラウザ認証） | 不明。OAuth は `offline_access`（refresh token）方式で固定期限を持たない |
| 2026-09-22 | wrangler のローカル OAuth（`migrations apply --remote`） | `code 7403` で拒否 | `wrangler whoami` では `d1 (write)` 権限ありと出るのに 7403 になった。**権限があることと、アクセストークンが有効なことは別**（`whoami` はスコープを見るだけで、トークン自体の有効性までは保証しない） | 再試行（`whoami` で更新後に再度 `migrations apply --remote`）で解消。フルの `wrangler login` は不要だった | 不明 |

補足:

- **`.env` が OAuth より優先される。** wrangler はプロジェクトの `.env` を先に読む（`cloudflare_api_token_sop_v1.md` 記載）。`.env` に古い `CLOUDFLARE_API_TOKEN` が残っていると、`wrangler login` してもそちらが優先されて直らないことがある。401/403 を見たら `npx wrangler whoami` でどちらの認証経路を使っているか先に確認する
- 2026-05-13 と 2026-05-26 の2件は**期限切れではない**（前者はヘッダ仕様の不一致、後者はトークンの無効化）。「期限監視を増やせば防げた」事象ではないので、対処と原因を混同しないこと
- `/user/tokens/verify` を能動的に叩いて 14日 WARN / 7日 CRITICAL を出す `auth-probe`（SOP §5 で設計だけ済み）は**未実装**。Notion 起票のまま。本節でも実装しない
- credential 期限の日報 WARN 自体は §6 とは別に既存の仕組みがある。§4-1 のような履歴ではなく「今後いつ切れるか」を見るときは `src/lib/token_expiry.ts` を参照

## 5. 既知の制約

1. **watchdog 直送の洪水抑制は Workers KV（`WATCHDOG_STATE`）に依存し、結果整合性である。**
   数秒間隔で連続失敗した場合、書き込みの伝播遅延により「連続 3 回で 1 通・以後 30 分抑制」が
   1 回効かず二重送信することがある（2026-09-11 の連投テストで実機確認）。本番の実行間隔は
   1 日 1 回のため実害はない。手動で `/?job=heartbeat` を連打する検証時はこの点を織り込むこと。
   完全な原子性が必要になった場合は Durable Objects へ置き換える。
2. `wrangler dev` を AI エージェントのセッションから起動すると secret（`.dev.vars`）が `env` に注入されない。
   認証込みの動作確認は vitest（フェイク D1）か、人間のターミナルから行う。
3. **時刻依存のテストは、JST/UTC の日付境界をまたぐ時刻で必ず検証する。「再実行したら緑になった」は原因究明を放棄した合図。**
   実例（2026-09-14）: `tests/autonomy.test.ts` のヘルパーがイベント時刻の起点を UTC の日付で計算していたが、
   集計窓は `date('now','+9 hours')` = JST の日付基準だった。両者は **UTC 15:00〜24:00（JST の翌日 00:00〜09:00）の
   9時間だけ1日ずれ**、最古のイベントが窓の外に落ちて 4 件が落ちた。**残り15時間は緑**なので、JST 早朝に push
   しなければ永久に気づかなかった。
   CI トークン失効（4ヶ月）・モデル廃止（4ヶ月）・vault-sync 停止（4.5日）と同系統だが、**「たまに赤い」は
   さらに気づきにくく、「CI が不安定」で片付けられて放置される**。時刻が絡む値は「今」を起点にせず、
   比較対象と同じ基準（この場合は JST 日付）に揃えること。

   **第2の現れ方: 件数のハードコードが窓の移動で期限切れする。** 日付が式に出てこないため、
   時刻依存だと気づきにくい。実例（2026-09-17 JST）: `roles_measured: 15` が期限切れして
   `origin/main` の CI が赤になった。CPO の唯一の実行実体 `cpo_platform_review` が毎月20日 cron で、
   28日窓のスライドにより `2026-08-20` が窓外に出たため（`2026-09-20` は未来なので窓内に候補日が
   1つも無くなった）。`expected_days=0` → `m_role_cadence=NULL` で平均の母数から外れ 15 → 14 になった。

   **対処**: `autonomy_window_override`（0007）で窓を固定する。seed 由来の集計値の読み取りは
   `pinnedOrgSummary()` を通し、`window_source` が `live` のままなら落とす。これで窓固定を忘れた
   固定値比較は「`15 !== 14`」ではなく「窓を固定してください」で落ち、原因がその場で分かる。

   窓を選ぶときに気にするのは **`monthly` ジョブの `cron_dom` だけ**でよい。`job_expected` は
   `cron_kind <> 'monthly'` のとき `expected_days_28d` を素通しするので、daily=28 / weekly=4 /
   hourly=28 は窓に対して不変である（**暦依存は月次ジョブ経由でしか発生しない**）。
   seed の月次は `dom=1`（CFO 2本）と `dom=20`（CPO 1本）の2種類だけなので、両方を含む28日窓
   （例: JST 2026-09-01〜09-28）を選べばよい。開始月と終了月を揃えると二重計上も避けられる。

   **未対処の同系統（既知の制約）**: 約30テストが `jstDaysAgoIso`（JS の `now`）でイベントを入れ、
   窓は SQLite の `date('now')` で評価される。挿入と SELECT の間に UTC 15:00（JST 00:00）をまたぐと
   窓が1日ずれて `daysAgo=28` のイベントが落ちる。テストは約4秒で終わるため発生確率は1回あたり
   **約 0.005%**。根絶には全テストのイベント生成を「窓終端からの相対」に書き換える必要があるため、
   2026-09-18 時点では記録に留めている。`success_days` が 28 のはずが 27 で落ちたら、まずこれを疑う。
4. **ブランチの起点が古いまま作業を進めない。マージ前に `python scripts/base_drift_check.py` で確認する。**
   2026-09-14 にこの系統の事故が**1日で3回**起きた。(1) `rebase` が他セッションの 48 コミットを書き換え始めた
   （`--abort` で回避）／(2) wip ブランチのまま本番 D1 の migrate を実行した／(3) 起点の古いブランチの PR を
   「`migrations/0013` とテスト3件を削除する差分だ」と読んでマージ前に閉じた。

   **(3) の読み方は誤りだった（2026-09-15 実測で訂正）。** `git diff --stat origin/main..<branch>`（二点差分）は
   「main にあってブランチに無いもの」を削除として表示するので、**起点が古いだけ**でも削除行が並ぶ。
   GitHub が PR に見せるのは三点差分（merge-base 基準）で、両者は別物である。
   - PR #10（`migrations/0013` を消しかけたとされた件）の実際の差分は **2 ファイル・+16/−4** で、
     `0013` は差分に含まれていなかった。**誤検知で閉じた**
   - main の直近 25 コミットで、マージによりファイルが消えた事実は **0 件**
   - 対照実験: merge commit / `git merge --squash` / 三点差分の適用の **3 方式すべてで
     main 側のファイルは残る**

   **同じ誤検知は 4 件目もあった（2026-09-15）。** PR #52 の前身 `feat/autonomy-metric-map-cron` を
   「`cloudflare/growth-collector` の 21 ファイル・約 2,000 行が消える」と読んでブランチを切り直した。
   実測すると二点差分は `21 files changed, 2293 deletions(-)` を出すが、**三点差分（＝ PR の実差分）で
   growth-collector に触れているファイルは 0 件**、実差分は `4 files changed, 498 insertions(+), 5 deletions(-)`
   だった。growth-collector は merge-base（`d54e8a7`）に存在せず、分岐後に main 側で追加されたもので、
   ブランチは存在すら知らなかった。**消失は起こり得なかった。**
   この件は数値そのものが誤検知の証拠になっている。**ブランチは一切変わっていないのに、二点差分の
   「削除行」は当時 1,986 行 → 現在 2,293 行に増えている**（main 側で growth-collector が +501 行
   成長したため）。この数値が測っているのは「ブランチが何を消すか」ではなく「main がどれだけ増えたか」である。

   **ただし切り直し自体が無駄だったわけではない。** 当時このブランチは実際に main から遅れており
   （現在の main 基準で behind 11）、起点を揃え直したことは正しい対処だった。
   **誤っていたのは理由（消失の回避）であって、対処（起点を新しくする）ではない。**
   この区別を失うと、将来「約 2,000 行の消失を未然に防いだ実績」として誤って記憶される。

   **3件目（2026-09-23・未コミット変更が「固有の編集」に見えた）**: `D:\tagtech` を
   `origin/main` へ揃える作業で、`stream/overlay.html` と `stream/progress_fullscreen.html` を
   「**main より新しい固有の編集を含む**（main 側は 2026-05-22 `b5a16b4` のまま）」と報告した。
   **これも誤りだった。**

   実態: これらは常駐スクリプトが数分ごとに**再生成**するファイルで、生成結果は当時も今も同じ。
   `D:\tagtech` が `feat/claude-md-v2`（main より 117 コミット遅れ）に居たため、
   **そのブランチの committed 版が古く、生成結果との差が「変更あり」として現れていた**だけである。
   切り替え後に `main` で同じスクリプトが走ったところ、**`git status` の変更は 0 件**になった
   （2026-09-23 11:39 に再生成されたことはファイル更新時刻で確認済み）。

   **見分け方**: 「ローカルが新しい」と判断する前に、**そのファイルが生成物かどうか**を確かめる。
   生成物なら、差分が示しているのは「ローカルの編集」ではなく「**ブランチの committed 版の古さ**」である。
   `git log -1 --format=%ci origin/main -- <file>` が何ヶ月も前で、かつファイルの mtime が
   分単位で新しいなら、まず再生成を疑う。

   **起点の古さ自体は依然として問題**である。ただし理由はファイル消失ではなく、
   **生成物を古い状態から作り直す**（自律度計測の seed 再生成がこの構造）・
   **main が追加したテストや制約を未検証のまま通す**（マージは通るのに main の CI が壊れる）の 2 点。

   したがって判断は「削除行が多いか」でも「merge-base に無いファイルが消えて見えるか」でもなく、
   **「それが実害のあるパスか」**で行う。CI の `起点ずれ検出（main の未取り込み）` が同じ判定をする。

   | 区分 | パス | 扱い |
   |---|---|---|
   | **要対処** | `migrations/` `data/` `scripts/` `tests/` `.github/workflows/` | **赤（exit 1）** |
   | 注記 | 上記以外（`docs/` 等） | 緑・警告のみ |

   **この絞り込みは 2026-09-18 に入れた。** 当初は未取り込みが 1 件でもあれば赤にしていたが、
   **検査自身を tagtech の main に入れたマージが docs を 1 ファイル追加した時点で、
   open PR 9 本すべてが赤になった**。実害の無い追加で全部が赤くなる状態は初日から無視される——
   「常に緑のチェック」の裏返しである。パス一覧は `scripts/base_drift_check.py` の
   `BLOCKING_PREFIXES` にあり、変更時は同じ場所の改訂メモに理由を書く。
5. 日本語を含むリクエストをシェルからインラインで `curl -d` すると cp932 経由で不可逆に化ける。
   必ず UTF-8 ファイルに書いて `--data-binary @file.json` で送る（`events` id=2,3 がその事故の痕跡。id=9 に注釈あり）。
6. 同一 Cloudflare アカウント内の Worker→Worker は workers.dev URL への fetch が error 1042 になる。Service Binding を使う。
7. **`scripts/base_drift_check.py` と `.github/workflows/base_drift_check.yml` は tagtech リポと
   同一内容の複製である。** パスも揃えてあるので、片方を変更したら必ずもう片方にも反映すること。
   同期の確認: `fc.exe D:\tagtech\scripts\base_drift_check.py D:\tagtech\projects\notify-gw\scripts\base_drift_check.py`
   運用手順・判定規則の詳細は tagtech リポの `docs/ops/base_drift_check_20260915.md`。
8. **日報先頭の「未解消 CRITICAL」は `agent_id LIKE 'notify-gw/selftest%'` だけを判定から除外している。**
   Phase1 の受け入れ検証（2026-09-10）で CRITICAL 経路の動作を確かめるために意図的に記録した failure
   （`events` id=2,3。上記5の cp932 事故の痕跡でもある）は、後から同じ `agent_id`+`action` の success が
   来ないため、持ち越し判定では永久に「未解消 CRITICAL: 1件（最古: N日前）」として先頭に居座った。
   **success を後付けで記録して消すことはしない**（起きていない成功を書くのは嘘の証跡。社長判断 2026-09-20）。
   判定 SQL（`src/lib/db.ts` `listUnresolvedCriticals`）の外側 WHERE で selftest だけを外し、
   解消判定（`NOT EXISTS` 側）には触れない。運用ジョブには一切効かない。
   除外を増やしたくなったら「解消の定義（success が記録される経路）」が足りていない合図なので、
   除外条件を足す前にそちらを疑う。
9. **この環境の bash では `TZ=Asia/Tokyo` が効かず、黙って UTC になる。**
   tz データベースが解決できないため、指定した時間帯ではなく UTC が返る。
   **エラーにならず、それらしい日時が返る**ので気づきにくい。

   ```
   date (local)  : 2026-09-22 02:27 +0900   ← 正しい（このマシンのローカルが JST）
   date -u       : 2026-09-21 17:27
   TZ=Asia/Tokyo : 2026-09-21 17:27 +0000   ← UTC に落ちている（+0000 が目印）
   ```

   実害（2026-09-22）: 並走検証の初日に `TZ=Asia/Tokyo date` の出力を JST として読み、
   **9時間ずれた時刻を報告した**。日報は `5 0 * * *` UTC（= 09:05 JST）に送られるので、
   「もう送信済み」と「まだ6時間半先」を取り違えるところだった
   （`digest_log` に当日行が無いことで気づいた）。

   **JST を出すときは次のどちらかを使う**。`%z` を必ず付け、`+0900` を目視する:
   ```bash
   date '+%Y-%m-%d %H:%M %z'                      # ローカルが JST ならこれでよい
   python -c "from datetime import datetime,timezone,timedelta; \
     print((datetime.now(timezone.utc)+timedelta(hours=9)).strftime('%Y-%m-%d %H:%M JST'))"
   ```
   **報告に時刻を書くときは必ずタイムゾーンを添える**（`+0900` / `JST` / `Z` のいずれか）。
   §6 の集計窓・cron の JST 換算・日報の対象日は、すべてこのずれの影響を受ける。

## 6. 自律度計測（autonomy_v1）

AI 組織の自律度を感覚値ではなく `events` の証跡から算出する。**LLM は使わない。全て SQL で決定論的に出す。**

| 要素 | 実体 |
|---|---|
| 台帳 | `agent_ledger`（追記専用・UPDATE/DELETE はトリガで ABORT）。最新断面は `agent_ledger_current`（= 最大 `batch_id` の行だけ）。**役職への帰属**だけを持つ |
| スケジュール | `job_schedule`（0007〜）。**定時実行の唯一の真実源**。役職に紐づかない `tagtech-cron/*` 等も載る。`agent_ledger` の `cron` / `expected_days_28d` 列は 0007 以降**参照しない**（追記専用テーブルなので列は残す） |
| 分類表 | `autonomy_metric_map`（report/intake/improve の該当判定）。唯一の真実源は tagtech リポの `data/autonomy_metric_rules.json` |
| ビュー | `autonomy_v1`（実行実体 job_id 単位）、`autonomy_v1_by_role`（役職単位）、`autonomy_org_summary`（組織サマリ。ダッシュボードはここを読む）。期待値は `job_expected`、窓は `autonomy_window` |
| 集計窓 | 直近 28 JST 日（当日は不完全なので除外）。JST日 = UTC 前日 15:00〜当日 15:00 の既存規約に揃える。`autonomy_window_override` に行を入れると窓を固定できる（テストと過去窓の再計算用。`window_source` が `override` になる） |

### 6-0. NULL と 0 の区別（最重要）

| 値 | 意味 |
|---|---|
| `NULL` | **未測定**。その項目の担当ではない／窓内に予定実行が無い（月次ジョブの対象日が窓外）／スケジュールが不明 |
| `0` | **担当で、予定実行もあったのに証跡が無い**（＝本当に動いていない） |

平均を取るときは `AVG()` が NULL を自動除外するので、未測定が平均を押し下げることはない。`autonomy_org_summary` はこの前提で組織平均を出す。

### 6-1. 6項目の算出式

| 項目 | 列 | 根拠にする証跡 | 式 |
|---|---|---|---|
| ①日報/報告 | `m1_report` | `autonomy_metric_map.metric='report'` のジョブの `result='success'` | 稼働日数バンド |
| ②タスク実行 | `m2_exec` | `action IN ('run','scheduled','deploy')` かつ `result='success'`（cron を持つ全実体に適用） | 稼働日数バンド |
| ③情報収集 | `m3_intake` | `metric='intake'` のジョブの成功 | 稼働日数バンド |
| ④証跡記録 | `m4_trace` | 窓内全証跡のうち `evidence_url IS NOT NULL OR meta LIKE '{%'` の割合 | 追跡可能率バンド |
| ⑤自己改善 | `m5_improve` | `metric='improve'`（prompt-self-update / ext_audit_skill_review）の成功 | 稼働日数バンド |
| ⑥自律判断 | `m6_judge` | `result='skip'`（自分で見送った）＋ `action IN ('cron-unmapped','binding-drift','binding-report-stale','deadline-approaching','deadline-overdue')`（自分で異常を検知した）。**`action='porting-pending'` はイベントごと除外**（0011〜） | 判断種別バンド |

- **稼働日数バンド**: `covered_days / expected_days` の達成率。0件→**0** / <30%→**1** / 30%以上→**2** / 60%以上→**3** / 80%以上→**4** / 95%以上→**5**
  `expected_days` は `job_expected` ビューが**窓ごとに解決**する（0007〜）。hourly/daily は 28、weekly は **28日＝ちょうど4週なので常に 4**（暦に依存しない）。**monthly だけは窓に対象日（`cron_dom`）が含まれるかで 0 か 1 になる**。窓外なら期待値は **0** で、切り上げはしない（`max(...,1)` は 0007 で廃止）。期待値が 0 または不明なら 6 項目すべて NULL（未測定）。
- **追跡可能率バンド**: 0件→**0** / <20%→**1** / <50%→**2** / <80%→**3** / <100%→**4** / 100%→**5**
- **判断種別バンド**: 判断の種類数をそのまま 0〜5 に飽和（5種類以上で 5）。低頻度が本質なので日数では測らない。
- **実体なしの除外（0012〜）**: ①②③⑤の分子からは `json_extract(meta,'$.expectation.ok') = 0` の証跡を除外する（「業務をせず、やり方の解説文を生成しただけ」の success を成果に数えない）。**④には適用しない**（実体が無くても証跡として記録されたことは事実で、記録の質の指標を汚さない）。**⑥は 0011 で別途対処済みなので二重適用しない**。
  **未判定（`meta` が NULL・`expectation` キー無し）は従来どおり数える。** ガードは opt-in 設計（`expect` 未指定の送信元は無改造で動く）なので、未判定を除外すると「検査していない」と「検査して実体が無かった」が混ざる。
  除外件数は `autonomy_v1.unsubstantiated_total` と組織サマリの `events_unsubstantiated` / `subjects_with_unsubstantiated` に出る。
- **NULL と 0 の違い**: §6-0 を参照。潰さずに区別する。
- 点数の隣に必ず生の実測値（`expected_days` / `success_days` / `exec_days` / `events_total` / `failure_total` / `traceable_total` / `decision_kinds` / `window_start` / `window_end`）が並ぶ。点だけで判断しないこと。

### 6-2. 照会

```sql
-- 実行実体ごとの自律度(点数と根拠を並べて見る)
SELECT subject, agent_id, m1_report, m2_exec, m3_intake, m4_trace, m5_improve, m6_judge,
       success_days, expected_days, events_total, failure_total
  FROM autonomy_v1 ORDER BY m2_exec DESC, subject;

-- 役職ごとの自律度。entity_count=0 が「名前はあるが実行実体がない」役職(点数は NULL=未測定)
SELECT agent_id, role_ja, level, entity_count, m_role_cadence, success_days, expected_days, decision_kinds
  FROM autonomy_v1_by_role ORDER BY entity_count DESC, agent_id;

-- 組織サマリ。未測定を除いた平均と、測定済/未測定の件数が出る(ダッシュボードはこれを読む)
SELECT * FROM autonomy_org_summary;

-- 予定実行が窓内に無い(= 未測定)実体の確認。月次ジョブが該当しやすい
SELECT subject, cron, cron_kind, expected_days FROM autonomy_v1 WHERE expected_days = 0;

-- スケジュール不明の実体(イベント駆動)。稼働率は測れないが証跡の質は測れる
SELECT subject, events_total, m4_trace FROM autonomy_v1 WHERE expected_basis = 'unknown';

-- 実体なしと判定された証跡を出している実体(= 業務をせず解説文を返している疑い)
SELECT subject, events_total, unsubstantiated_total, success_days, m2_exec
  FROM autonomy_v1 WHERE unsubstantiated_total > 0 ORDER BY unsubstantiated_total DESC;

-- 除外の規模。0 のまま増えないなら「送信元がまだ expect を宣言していない」ことを意味する
SELECT events_unsubstantiated, subjects_with_unsubstantiated FROM autonomy_org_summary;

-- 台帳に無いのに動いている実体(逆に、台帳にあるのに動いていない実体は m2_exec=0)
SELECT subject, events_total FROM autonomy_v1 WHERE ledger_registered = 0;

-- 集計窓の確認(実行時刻で動く)
SELECT * FROM autonomy_window;
```

### 6-3. 再現手順（台帳の作り直し）

台帳は追記専用なので、**訂正は新しい `batch_id` の追記で行う**（既存行は書き換えない）。

1. tagtech リポ側で生成: `python D:/tagtech/scripts/agent_ledger_export.py`
   - 元データ（台帳）: `data/employee_roster.json`(69名・`scripts/role_registry.py` で role_code 化) / `projects/tagtech-automation/src/index.ts` の `cronToTasks`(38タスク・`[ROLE]` タグ) / `data/role_model_config.json` / `data/autonomy_metric_rules.json`
   - 元データ（スケジュール）: 上記 `cronToTasks` に加えて `cloudflare/tagtech-cron/src/index.ts` の `CRON_MAP`(23件・`SUN` など曜日名表記あり) / `cloudflare/vault-intel/wrangler.toml` / `projects/notify-gw/wrangler.jsonc`
   - 出力: `migrations/000N_agent_ledger_seed.sql`（台帳92行）/ `migrations/00NN_job_schedule_seed.sql`（スケジュール63件）/ `docs/ops/agent_entity_reconciliation_*.md`
   - **抽出できなかった対応は NULL(実体なし)として出力し、推測で埋めない。** スクリプト冒頭の `BATCH_ID` / `REFERENCE_DATE_UTC` を更新してから実行する
2. 差分ゼロの確認（再現性）: `python D:/tagtech/scripts/agent_ledger_export.py --check`
3. ローカル検証: `npm test` → `npm run db:migrate:local` → §6-2 の SQL
4. 本番反映: `npm run db:migrate:remote`（**社長の手で実行する**。AI セッションからは実行しない）

**CI が担保する範囲と、担保しない範囲（勘違いすると事故る）:**

| | 誰が見るか |
|---|---|
| 分類表と roster の整合性（JSON 崩れ・無効な metric・`reason` 空・`job_id` 重複や形式・未分類宣言との矛盾・69名とレベル内訳・モデル解決） | **tagtech CI「自律度 分類表チェック」が自動で見る**（`--validate-rules`） |
| **生成物（`0005`/`0010`/`0013`）が最新かどうか** | **CI では見られない。開発マシンで `--check` を実行する人間の責任** |

CI で生成物を照合できない理由: エクスポータは `cronToTasks`（別リポジトリ `tagtech-automation`）・`CRON_MAP`（tagtech の main に未取り込み）・出力先（notify-gw リポジトリ）を跨いで読むため、**CI のチェックアウトには入力が揃わない**。揃わない状態で `--check` を回すと「差分あり」ではなく「入力が読めない」で落ち、検知として意味を持たない。
したがって **`cronToTasks` / `CRON_MAP` を変更したら、開発マシンで上記 1→2 を実行して差分ゼロを確認すること**。CI が緑でも生成物が古い可能性は残る。

### 6-4. この指標で測れないこと（読む前に必ず確認する）

1. **0点は「やるべきなのにやっていない」であって「能力なし」ではない。** 実体なし・予定実行なしは 0 ではなく NULL（§6-0）。⑥自律判断は異常が起きなければ 0 になる。判断機構の有無はコード側の話で D1 からは測れない。
2. `events` に送られていない失敗は測れない（握り潰しの検出は不可）。
3. **②が高くても「成果が届いた」証明にはならない。**「動いた」と「届いた」は別問題。2026-09-14 の実測（Phase 4-3 マージ後の origin/master・別セッション調査）:
   - `tagtech-automation`: LLM 出力を **meta に約200字のプレビューだけ保存**している（例: `prompt_self_update_morning` 出力長1479 → 保存199、`prompt_self_update_night` 1112 → 200）。**約93%は捨てている**
   - `tagtech-cron`: 出力を**完全に破棄**している（保存 None）

   つまり⑤自己改善のスコアが高くても、改善提案そのものが人に届いているとは限らない。
4. **実体なしの除外は対症療法である（0012）。** 根治は `cronToTasks` の指示文の書き直しであり、Phase 6 以降の別作業。**この除外があるからといって問題が解決したとは見なさない。**
   構造の実態（2026-09-14 に別セッションが特定）: これらのタスクは「未実装」だったのではなく、**Cloudflare 移行時に Python 実装側を止めたが、移行先が LLM プロンプトだったため業務そのものが消えた**。対応する Python 実装はほぼ全件実在するが schtasks がほぼ全て Disabled になっている。2026-04-20 の n8n 移行事故と同型の再発である。
   **除外件数の増減は3通りに解釈できるので必ず区別すること**: (a) 実体なしが減った（改善）／(b) `expect` を宣言する送信元が減った（計測の後退）／(c) Workers への移植が進んで実体を持つようになった（`expect` が `deterministic` → `external_data` に変わる。**これは数値が上がるが「自律度の向上」ではなく「測定対象の正常化」**）。
   さらに(d) **測定範囲の拡大による変動**: `autonomy_metric_map` にジョブを追加すると分母が増え平均が動く。**これは改善でも悪化でもない。** 変更日と適用前後の値を必ず併記すること（実績: 2026-09-15 の `0013` で `tagtech-cron` の20ジョブを追加し、`avg_m1_report` 0.88→0.67・`avg_m3_intake` 1→0.57・`avg_m5_improve` 1→0.57 と下がった。これは新たに測れるようになった実体の大半が未移植スタブで 0 点だったためで、悪化ではない）。
   (e) **台帳の batch が進むと母集団が変わる。自律度の比較は必ず `batch_id` を併記する（必須）。**
   `agent_ledger_current` は最新 batch を指すので、新 batch を追加した瞬間に「実体あり役職数」＝
   `roles_measured` の母数が変わる。実績: 2026-09-21 の `0015`（batch `2026-09-21T00:00:00.000Z`）で
   ciso 停止・google_calendar_sync / cio_daily_news 降格を反映し、実体あり **15 → 13 役職**（実体なし 54 → 56）。
   基準線（登録69 / 実体あり15 / 実体なし54、2026-09-18 記録）は batch `2026-09-14` の値であり、
   batch を書かずに 13 と 15 を並べると「2役職ぶん後退した」と誤読する。これも「測定対象の正常化」であって
   自律度の変化ではない。**照会・ダッシュボード・報告のいずれでも `SELECT MAX(batch_id) FROM agent_ledger` を
   添える**（凍結した 09-14 batch と比較したいときは `WHERE batch_id = '2026-09-14T00:00:00.000Z'` で明示する）。
   seed 由来の固定値テスト（`tests/autonomy.test.ts` の 69/13/56）も batch を進めるたびに追随させる。
   `0014`（`job_schedule` 入れ替え）でも同型のことが起きた: schedule から外れたジョブ（`pipeline_weekly` /
   `daily-standup`）を前提にしたテストが `expected_days=NULL` で落ちた。**seed を入れ替える PR では、
   マージ前に `npm test` が seed の新しい姿で通ることまで確認する**（2026-09-20 は #22 / #23 のマージ後に
   main の CI が赤になって気づいた）。
5. **同一業務が二重に数えられている（2026-09-14 時点・Phase 6 で解消予定）。** `tagtech-automation` と `tagtech-cron` で同じジョブ名が8組ある（表記ゆれ `_` と `-` で別ジョブに見えていた。`daily_standup`/`daily-standup`、`funding_reminder`/`funding-reminder`、`pipeline_daily`/`pipeline-daily`、`prompt_self_update_{morning,evening,night}` の3組、`revenue_dashboard`/`revenue-dashboard`、`youtube_shorts`/`youtube-shorts`）。

   **ただし実処理が重複しているのは `funding-reminder` の1件だけ。** 残り7本の `tagtech-cron` 側は `action='porting-pending'` / `result='skip'` の未移植スタブで、実処理も LLM 呼び出しもしていない（2026-09-14 に本番 events を複製したローカル D1 で確認: daily-standup / pipeline-daily / prompt-self-update-morning / revenue-dashboard / youtube-shorts はいずれも `porting-pending / skip / WARN` のみ）。
   したがって**稼働日数バンドの分子は汚れていない**（`m2_exec` は `result='success'` かつ `action IN ('run','scheduled','deploy')` が条件で、skip は数えない）。膨らんでいるのは **`subject` 数と組織サマリの件数**、および後述の⑥だけ。
   社長決定により `tagtech-automation` に寄せ、`tagtech-cron` 側は cron を外して降格する（削除はしない）。降格の理由はコスト削減ではなく**通知ノイズの除去と計測の正確性**（この7本は日報の「未移植: N ジョブ」の主要因でもある）。
6. **⑥自律判断がスタブを過大評価していた（2026-09-14・`0011` で修正済み）。** `action='porting-pending'` を判断として数えていたため、**一度も実装されていないスタブが `m6_judge=1` を得ていた**（実測で18件。`tagtech-cron/daily-standup` は `m2_exec=0` なのに `m6_judge=1`）。修正後は 0 件、`avg_m6_judge` は 0.3 → 0.02 になった。

   **採否の基準（新しい action を⑥に加えるときは必ずこれに照らすこと）:**
   > ⑥自律判断に数えてよいのは、**入力に応じて結果が変わりうる判断のみ**。固定値を返すスタブ・未移植マーカー・定数レスポンスは対象外。

   **実装上の落とし穴**: 「判断種別のリストから `porting-pending` を外す」だけでは1件も直らない。式が `CASE WHEN result='skip' THEN 'skip' ELSE action END` なので `result='skip'` の分岐が先に当たり、記録される種別は `porting-pending` ではなく `skip` になっている。絞り込みも `(result='skip' OR action IN (...))` なので、`IN` リストから外しても `result='skip'` 側で拾われ続ける。**イベント単位で `action <> 'porting-pending'` を除外**する必要がある。
   なお `m2_exec=0` かつ `m6_judge>0` は一律の矛盾ではない。**実行に失敗し続けているジョブが期限超過を正しく検知した場合**はこの組み合わせが正しいので、テストで境界を固定してある。
   **降格後は必ず `job_schedule` を再生成すること**（`python D:/tagtech/scripts/agent_ledger_export.py`）。降格したジョブは `CRON_MAP` から消えるので `job_schedule` からも落ち、`expected_basis='unknown'` → 稼働率は NULL（未測定）になる。**「申告途絶で0点」にはならない**設計なので、降格そのものが誤検知を生むことはない。
7. 役職と実行実体の対応が付くのは `cronToTasks` の `[ROLE]` タグがある 15 役職のみ。`tagtech-cron` の 24 ジョブはコード上に役職タグが無いため、どの役職の実体かを主張しない（`ledger_registered=0` として現れる）。部長11・係長17・一般25 の 53 名は実行実体なし。
8. **`autonomy_v1` は 2026-09-14 に一度書き換えた（0007）。** §6 には「定義変更時は書き換えず `autonomy_v2` を作る」と書いてあるが、この時点では 28 日窓がまだ埋まっておらず（証跡は 2026-09-10 開始）、正式記録も対外公表も一度も行っていない＝保護すべき過去の点数が存在しなかったため、例外として v1 を直接修正した。**2026-10-11 の初回正式記録以降に定義を変えるときは `autonomy_v2` を作ること。**
9. **`autonomy_window_override` に行を残したまま忘れると窓が固定される。** 検知は `SELECT window_source FROM autonomy_org_summary`（`override` なら上書き中）。用が済んだら `DELETE FROM autonomy_window_override;`。
10. `wrangler d1 migrations apply` に down 機構は無い。ロールバックは手動 DROP:
   `DROP VIEW autonomy_org_summary; DROP VIEW autonomy_v1_by_role; DROP VIEW autonomy_role_expected; DROP VIEW autonomy_v1; DROP VIEW autonomy_base; DROP VIEW autonomy_subjects; DROP VIEW job_expected; DROP VIEW autonomy_evidence; DROP VIEW autonomy_window; DROP TABLE job_schedule; DROP TABLE autonomy_window_override;`
   台帳自体を戻す場合は `DROP VIEW agent_ledger_current; DROP TRIGGER agent_ledger_no_update; DROP TRIGGER agent_ledger_no_delete; DROP TABLE autonomy_metric_map; DROP TABLE agent_ledger;`（既存 `events`/`agents`/`digest_log`/`expected_bindings`/`binding_reports` には一切触れていないのでデータは失われない）

## 7. 設計原則: 真実源は1つ（同じ概念の台帳を複数作らない）

ある概念（エージェント、ジョブ、期待値、設定）について、**正となるデータの置き場所は常に1箇所**とする。
同じ概念を表すテーブル・ファイル・外部サービス上の DB を並行して持たない。

- 既存の真実源で表現が不足する場合、**新しい台帳を作るのではなく既存側に列・行を追加して拡張する**
- 用途が違うように見えても、同じ実体を指すなら統合を優先する。参照が必要な側は真実源を見に行く（**逆向きの複製をしない**）
- **新規テーブル・新規台帳の作成に着手する前に、他セッションの作業中ブランチと未マージ設計を確認する**

### なぜ

台帳が複数あると、どちらが正かで必ず齟齬が生じる。本プロジェクトが解決した「作り話 68 件」も
「CI が 4 ヶ月沈黙していた件」も、**実態と記録の乖離が誰にも見えなくなったこと**が原因であり、
台帳の二重化はその乖離を自ら作り出す行為にあたる。

### 本プロジェクトでの適用実績（判断の根拠として記録）

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| 1 | `agents` テーブル vs `agent_ledger` | **`agent_ledger` に一本化**。`agents` は削除せず `_deprecations` に非推奨として記録 | `agents` は PRIMARY KEY 制約で「1役職 = 複数実行実体」を表現できない。追記専用の思想にも合わない |
| 2 | `agent_ledger.notion_url` / Notion 側エージェント名簿 | **構想ごと取り下げ。Notion に役職ページ・名簿 DB は作らない** | `agent_ledger` は `role_ja` / `level` / `department` / `worker` / `job_id` / `cron` / `model` を持ち、責任範囲の定義として既に充足している。Notion 側に名簿を作れば #1 と同じ「台帳が2つ」問題の再来になる。**真実源は D1 の `agent_ledger` 1つとし、Notion は人間がタスクを回す場所に徹する** |
| 3 | 期待バインディング一覧 | **notify-gw の D1（`expected_bindings`）を唯一の置き場とする** | 各リポの設定ファイルにハードコードすると、増減のたびに N 箇所を直すことになり必ずズレる |

#2 の調査結果（2026-09-14 実機）: `data/employee_roster.json` のフィールドは
`full_name` / `reading` / `role_ja` / `persona` / `emoji` のみで Notion URL 相当は 0 件。
Notion 側にエージェント名簿 DB は存在せず「タスク管理」DB のみ。その担当プロパティは
`people` 型ではなく **`rich_text`**（値は `COO 葛城直人` 形式）。よって役職→Notion ページの URL は
どこにも存在せず、作るなら URL 生成規則の新設が必要になり、`agent_ledger.source` 列の
「出典 file:line 必須」という規律を満たせない。

### 7-2. 原則の例外: `CRON_MAP` と `wrangler.jsonc` の二重管理

`tagtech-cron` は cron 式を **2 箇所**に持っている。

| 場所 | 役割 |
|---|---|
| `wrangler.jsonc` の `triggers.crons` | **Cloudflare が実際に発火させる**定義。ここに無い cron は動かない |
| `src/index.ts` の `CRON_MAP` | 発火した cron を**どのジョブに振り分けるか**の対応表 |

これは「真実源は1つ」に反するが、**Cloudflare Workers の仕様上どちらも必須で分離できない**。
`crons` は Cloudflare 側の設定、`CRON_MAP` はコード側のルーティングで、
一方から他方を生成する仕組みが Workers には無い。

**したがって二重管理そのものは許容し、代わりに「ズレないこと」を機械的に保証する。**

- `scripts/predeploy_check.mjs` の検査2 が両者を突き合わせ、**1:1 でなければ deploy を止める**
- 同じ検査を `tests/predeploy_guard.test.ts` にも置き、ゲート自身の回帰を防ぐ
- 検査するのは ①`CRON_MAP` にあるが `crons` に無い（ジョブが発火しない）
  ②`crons` にあるが `CRON_MAP` に無い（「対応表にない cron」の誤アラートが出る）
  ③ジョブが空のエントリ ④`crons` の重複 ⑤`CRON_MAP` のジョブ名が `JOBS` に定義済みか

**なぜ許容してよいか**: 「真実源は1つ」が防ぎたいのは「**どちらが正か分からなくなること**」である。
ここでは `crons` が発火の真実源、`CRON_MAP` が振り分けの真実源と**役割が排他的に分かれており**、
重複しているのは cron 式という**キーだけ**。そのキーの一致を機械が毎回検証するので、
人の記憶や注意力に依存しない。**人が両方を目視で合わせる運用だったら許容しない。**

実害の記録: 2026-09-14 の降格作業で `"0 13 * * *"` を `CRON_MAP` からは消したが
`wrangler.jsonc` に残し、検証スクリプトが検出した。目視では見落としていた。

### 併せて守る既存原則

| 原則 | 意味 |
|---|---|
| **沈黙は異常** | ハートビート・死活監視は必ず**外部化**する。監視対象自身に自分の死活を報告させない |
| **Never auto-delete** | 削除ではなく降格・非推奨化。消さずに「使わない」と記録する |
| **台帳は「あるべき姿」、証跡は「実際」** | 台帳は人が管理する。**実態が台帳を自動更新しない**（乖離は検知して報告するだけ） |
| **本番デプロイは CI 経由のみ** | **既定は `main` への push（= PR のマージ）で CI がデプロイする**。手元 `wrangler deploy` は例外手順（§8-1-b-2）で、CI が使えないときだけ・毎回社長承認。同一 Worker を複数セッションが手元デプロイすると黙って巻き戻る（§8-5 の実例2）。**Deploy が失敗しても手元デプロイで回避しない**——原因を報告し承認を得てから動く |
| **解消されていない異常は解消されるまで毎日繰り返し報告する** | 1回通知して終わりにしない。**人が見落とすことを前提に設計する。** 解消は機械が判定し（同じ `agent_id`+`action` で success が記録されたか）、人の「確認済み」操作は設けない（人の操作に依存すると、それ自体が忘れられる）。2026-09-15 の Deploy 失敗は #alerts にも日報にも出ていたが3日間見逃された（§7-3） |
| **期限のある credential は期限自体を監視対象にする** | 切れてから気づくのではなく、切れる前に日報へ出す（§4 参照） |
| **書き込みの成否は読み戻して確認する** | 応答・終了コードは成功の証明にならない。外部への書き込み（Notion / GitHub / Discord / D1）の後は読み戻して格納値を検証し、検証したことを証跡に残す（下記） |
| **共有ディレクトリでブランチを切り替えたら、作業後に `main` に戻す** | `D:\tagtech\projects\notify-gw` のような「本番適用の起点」に使う checkout は、他セッション・社長の手順書が **`main` であること**を前提にしている。docs ブランチ等に切り替えたまま離れると、次に使う人の `git pull --ff-only` は「Already up to date」と答え、`migrations list --remote` は「No migrations to apply」と答える。**どちらも嘘ではないが、見ているブランチが違う。** 切り替えが必要なら別 worktree を切る。共有 checkout で切り替えたなら、作業の最後に `git switch main` まで含めて1作業とする（実例: §8-1-d） |
| **共有 checkout を触るのは常に1セッションだけ**（2026-09-22 制定） | 着手前に `python D:/tagtech/scripts/sessions_status.py` で他セッションの cwd を確認する。他セッションが居たら**提示のみで実行しない**。並行作業は `D:/tagtech-task-{name}` の worktree で行う | index と HEAD は worktree 内の全セッションで共有され、相手のステージ済み変更を巻き込む（INC-20260522-003/004）。2026-09-22 には共有 checkout が別セッションのブランチのまま残り、**812 コミットが main へ流れない状態が数日続いた** |
| **作業用 worktree は `main` をチェックアウトしない**（2026-09-22 制定） | フィーチャーブランチか detached HEAD で使う。`git worktree add -b <branch> <path> origin/main` のように**起点を明示**する | git は同一ブランチを複数 worktree で同時にチェックアウトできない。**`main` を掴んだ worktree が1つあるだけで、共有 checkout を `main` に戻せなくなる**。実例（2026-09-22）: 役目を終えた `D:/tagtech-cron-port` が `main` を掴んだまま放置され、`git switch -C main origin/main` が `fatal: 'main' is already used by worktree` で停止した |
| **決裁済みの規約を、決裁者に諮らず巻き戻さない** | `CLAUDE.md` / `.claude/agents/` / **この原則表** の変更は社長承認を経る。**社長が承認・マージした PR を、社長に諮らず revert しない。** 設計思想に異論があるときは、revert ではなく社長へ論点を上げる。実例（2026-09-21）: 社長が承認・マージした `.claude/agents/tagtech-ops.md`（tagtech PR #96）が、別セッションの判断で「書き込み系ツールを持つのは分業原則に反する」として revert された。論点自体は正当だったが、**決裁済みの変更を決裁者に諮らず巻き戻すと、何が有効な規約なのか誰にも分からなくなる**。社長判断で復活（PR #102）|
| **承認が要る境界は「マージ・本番・破壊操作」であって「push」ではない**（2026-09-22 社長決定で明確化） | 事前確認不要: **承認済みタスクのフィーチャーブランチへの push・PR 作成**。承認必須: **`main` への直接 push・マージ・デプロイ・D1 `--remote`**。常に禁止: **force-push**。それ以前は「push は都度承認」と広く読める書き方をしており、2026-09-22 に AI セッションがフィーチャーブランチの push を「承認前」と誤解して作業を止めた。社長判断: 「承認を待つ回数を増やしても安全性は上がらない。止まるべき場所（マージ・本番）で確実に止まること」 |

### 7-1. 「書き込みの成否は読み戻して確認する」の実績

「確認しているつもりで確認になっていない」という同型の沈黙パターンが繰り返し出ている。

| # | 事例 | 何が起きたか |
|---|---|---|
| 1 | Notion rich_text のバックスラッシュ消失 | `create` の応答は**送信内容のエコー**で `\` が残って見えたが、`fetch` で読み戻すと `D:	agtech\website` が `D:tagtechwebsite` になっていた |
| 2 | vault-sync の `curl` 400 沈黙 | `curl -s` は **HTTP 400 でも終了コード 0** を返すため、スクリプトが成功とみなして Discord フォールバックもスキップし、完全な無音になるところだった |
| 3 | **D1 マイグレーションの未適用（2026-09-15）** | 「適用した」という報告を受けたが、確認 SQL を回すと `autonomy_org_summary` が存在せず `contradiction` も 22 のままだった。追跡すると **PR マージと `git pull` は成功しており、`wrangler d1 migrations apply` だけが効いていなかった**。確認 SQL を回していなければ「⑥自律判断バグは解消済み」という誤った前提で作業が進んでいた |
| 4 | **`--rebase` マージ後の自己重複（2026-09-15）** | PR を `--rebase` でマージすると base 側に**別 SHA の同一コミット**ができる。元ブランチに追加修正を積んで再度 PR を出したところ、git が両方を別物として扱い `the merge commit cannot be cleanly created` で**マージ不能**になった。他セッションの変更との競合ではなく**自己重複**だった |
| 5 | **検査を足したのに前提を整えていない（2026-09-18）** | predeploy に「マージ済みか」の検査（`git merge-base --is-ancestor HEAD origin/master`）を追加したが、`actions/checkout` の既定が **shallow clone（`depth=1`）**であることを見落とした。`HEAD~1` も `origin/master` も存在せず、**CI と Deploy が 2026-09-15 から3日間落ち続けた**。手元には全履歴があるためテストは緑で、気づけなかった |
| 6 | **鍵ファイルの CR 混入（2026-09-21）** | `.run-key.txt` を「49バイト・末尾改行なし」と確認して GitHub Actions secret に投入しようとした。バイト数は想定どおりだったが、**49バイト目が CR（`0x0d`）**で、実鍵は 48 バイトだった（Windows 改行の残骸）。`< file` のリダイレクトで投入していれば**値に CR が付いたまま格納**され、CI からの証跡送信が全て 403 になる。**しかも Deploy 自体は成功するので誰も気づけない**（§7-3 と同じ沈黙の形）。`wc -c` だけでなく `tail -c 1 \| od -An -tx1` で**中身の末尾バイト**を見て発覚した |


**3例目の教訓**: 経路の一部が成功していると全体が成功したように見える。**最終的な状態そのもの**（D1 なら `d1_migrations` の件数とビューの実在、Notion なら格納値、GitHub なら commit の中身）を読んで確かめる。

**6例目の教訓**: **「サイズが想定どおり」は中身が正しいことの証明にならない。**
バイナリ的に1バイト違うだけで壊れる値（鍵・トークン・ハッシュ）は、長さではなく**末尾バイト**まで見る。
鍵ファイルの扱いは §4-2 に手順としてまとめた。

**4例目の教訓**: `--rebase` マージは元ブランチと base に同じ内容の別コミットを残す。
**マージ後に追加修正が必要になったら、元ブランチを使わず base から新しいブランチを切る。**
元ブランチに積むと必ず自己重複する。解決は「必要なコミットだけを base から切った新ブランチへ
cherry-pick」。`force-push` は不要で、元ブランチも残せる。
移植16件で繰り返し発生しうるので、**マージ済みの機能に修正を足すときは毎回この形にする。**

競合を見たら、まず **`git log <merge-base>..origin/<base>` で base 側に何が入ったか**を確認する。
相手の変更なのか自分のコミットのコピーなのかで対処がまったく違う。

**5例目の教訓**: **検査を足したら、その検査が必要とする前提も一緒に整える。**

新しい検査は、それが依存する環境（git の履歴・ネットワーク・認証情報・ファイルの実在）を
暗黙に要求する。**手元とCIでは前提が違う**ので、手元で緑でも CI で落ちる。

履歴を見る検査を入れたら `actions/checkout` に `fetch-depth: 0` を指定する。
外部 API を叩く検査を入れたら、CI にその認証情報があるかを確認する。

あわせて、**前提が満たされないときに「判定不能」と言えるようにする。**
今回の実装は base が無いのに「未マージです」と報告しており、原因を見誤らせた。
`git rev-parse --verify` で base の実在を先に確かめ、無ければ
「判定できません（`fetch-depth: 0` を指定してください）」と出すよう直した。
**「取れなかった」と「無い」を区別する**という方針（モデル監視・Notion 疎通でも同じ）を
ここにも適用する。

### 7-4. 原則が「書いてある場所」に居ないと、読まれない（2026-09-22 発見）

**このファイルに原則を書いても、このファイルを読まないセッションには届かない。**

2026-09-22 に判明: **`CLAUDE.md` には運用原則が1つも書かれていなかった**
（前日に追加した「規約の無断 revert 禁止」のみ）。原則表・実例・手順はすべて
この RUNBOOK にしか無く、**`D:\tagtech` で作業するセッションは CLAUDE.md を読むが
notify-gw の RUNBOOK は読まない**ため、原則が届いていなかった。

これは並行セッションで**同型の事故が繰り返された一因**である。読んでいない規律は
守りようがない。実際、2026-09-20〜22 に起きた次の件は、いずれも RUNBOOK に
既に書いてあった原則に触れている:

| 事象 | 触れていた原則 | RUNBOOK での記載時期 |
|---|---|---|
| 2つの起点から手元デプロイして互いに巻き戻した | 本番デプロイは CI 経由のみ | §8-1-b-2（09-18） |
| 決裁済みの `.claude/agents/` を諮らず revert した | 決裁済みの規約を巻き戻さない | ——（この件で新設） |
| 確認目的でジョブ実行ルートを叩いた（3回） | 確認のために本番を動かさない | §8-0（この件で新設） |
| 共有 checkout のブランチ違いで誤認（2回） | 判断の前に現在ブランチを確認 | 原則表（09-21） |

**対処（2026-09-22・tagtech PR #107）**: 原則の要約を `CLAUDE.md` の先頭付近へ置いた。
ただし**真実源は増やさない**——CLAUDE.md には「一次資料は RUNBOOK の原則表。
食い違ったら RUNBOOK が正。**変更するときは両方同時に直す**」と明記し、
各原則に「破ったときに起きたこと」列を添えた（抽象的な訓示は読み飛ばされるため、
実際の事故と対応させる）。

**一般化**: 規律を作ったら「**それを読む人が実際に開くファイル**に置かれているか」を
必ず確認する。置き場所が間違っている規律は、存在しない規律と同じ振る舞いをする。
§7 の「真実源は1つ」と衝突しないよう、要約側には必ず**どちらが正かと同時更新の義務**を書く。

### 7-5. 書いてあっても、書いた本人が同じ場で破ることがある（2026-09-22）

§7-4 は「原則が置かれていない場所では読まれない」という事故だったが、これは**その逆**:
**原則を自分で書いた直後、同じセッション内で自分がその原則を破った。**

2026-09-22、承認境界の原則（本節冒頭の表に追加した行。「push/PR作成は事前確認不要、
`main` への直接 push・マージ・デプロイ・D1 `--remote` のみ承認必須」）を RUNBOOK に
追記するコミット自体を、**PR を経由せず `git push origin main` で直接 main に反映した**
(commit `fb376dd`)。社長の指示は「退避ブランチ → `reset --keep` → PR」だったが、
それとも「main への反映は常に PR 経由」という直前に決めたばかりの規約とも異なる手順を取った。

**経緯**: 別ブランチでの並行作業（判断1 PR のCI待ち・判断2の migration 設計）の合間に、
ローカル main に直接コミットしていた2件（判断3チェックリート記入・本節の承認境界追記）が
`origin/main` と分岐した。分岐の解消を「git操作として技術的に正しく揃える（rebase→push）」
タスクとして処理し、**その揃え方自体が承認境界の対象であることに立ち返らなかった**。
ルールを言語化した直後でも、実行の場面では別の思考(目の前の分岐を早く解消する)に
切り替わり、原則を照合しなかった。

**実害の確認**:
- `gh run list` で `fb376dd` の push イベントを確認 → 発火したのは `CI` と
  `起点ずれ検出`のみ。**`Deploy` ワークフローは起動していない**(`docs/RUNBOOK.md` は
  `deploy.yml` の path フィルタ`src/**`・`wrangler.jsonc`等に含まれないため)。本番デプロイは発生していない
- `fb376dd` はマージコミットではない(親1つ、`docs/RUNBOOK.md` 1ファイル+1行のみ)
- 副次的に判明した別件: 判断1のPR(#38 `feat/vault-digest-task-count`)は、
  ブランチを**ローカル main から**切ったため(本来は `origin/main` から切るべきだった)、
  当時ローカル main にあった判断3のチェックリートコミットも一緒に運ばれ、
  PR #38 のマージ経由で `origin/main` に混入していた。内容自体は問題ないが、
  「別の作業(判断1)のPRに無関係な変更(判断3)が紛れ込む」という、
  §7-1 実例4の「`--rebase` マージ後の自己重複」とは別種の取り違えが起きていた。
  **対処(規則として明記)**: 別PR用のブランチは必ず `origin/main`(fetch 済みの最新)から切る。
  ローカル main が未pushのコミットを持っている状態で `git checkout -b` すると、
  その未pushコミットが新しいブランチの祖先に入り込み、無関係なPRに混入する。
  `git worktree add -b <branch> <path> origin/main` のように起点を明示すれば、
  ローカル main の状態に関係なく事故を防げる(このRUNBOOK自体、本節以降の全PRで実践している)

**社長判断**: 内容(docsの文言)自体は承認済みのため revert はしない
(revert も main への変更になり、問題の解決にならない)。**手順の逸脱として記録に残す。**

**教訓**: 「原則を書いた」ことは「原則を守れる状態になった」ことを意味しない。
実行の瞬間に照合する仕組み(=人の記憶に依存しない構造的な防止策)が無い限り、
同じセッション内でも再発しうる。→ 構造的対策として GitHub ブランチ保護(`main` への
直接 push 禁止・PR 必須・CI 必須化)を検討(2026-09-22 提案・社長が設定要否を判断)。

### 7-6. ユーザー側フックはリポジトリ版のコピーであり、黙ってズレる（2026-09-22）

**リポジトリのフックを直しても、実際にブロックしているのは別のファイルだった。**

2026-09-22、`deny-check.sh` の誤検知（禁止コマンドを**文字列として**含むだけの操作を拒否する）を
tagtech PR #137 で直し、`origin/main` への着地も読み戻しで確認した。**それでも誤検知は続いた。**
実際に発火していたのは `C:\Users\tagme\.claude\scripts\deny-check.sh`（リポジトリ外・ユーザー側）で、
PR で直したのは `.claude/hooks/deny-check.sh`（リポジトリ側）だったため。

#### 現状（2026-09-22 実測）

ユーザー側 `C:\Users\tagme\.claude\settings.json` に登録されているフックは12件。
うち `~/.claude/scripts/` の実体を指すものが6件あり、リポジトリ側と突き合わせると:

| ユーザー側の実体 | リポジトリ側の対応 | 一致するか |
|---|---|---|
| `deny-check.sh` | `.claude/hooks/deny-check.sh` | 一致（**本件で揃えた**） |
| `token-waste-check.sh` | `.claude/hooks/token-waste-check.sh` | 一致 |
| `forbidden-term-check.sh` | `.claude/hooks/forbidden-term-check.sh` | **ズレている** |
| `prompt-logger.sh` | `.claude/hooks/prompt-logger.sh` | **ズレている** |
| `n8n-workflow-validate.sh` | `.claude/hooks/n8n-workflow-validate.sh` | **ズレている** |
| `read-deny-check.sh` | —— | **リポジトリに無い（ユーザー側のみ）** |

残り6件は `python D:/tagtech/.claude/hooks/*.py` の形でリポジトリ内を**直接参照**しており、
コピーではないのでズレない（`session_collision_guard.py` / `session_register.py` ×3 /
`memory_orphan_check.py` / UserPromptSubmit の memory 読み込み）。

#### 2つの方式と、それぞれの落とし穴

| 方式 | 例 | 落とし穴 |
|---|---|---|
| **コピー運用**（`~/.claude/scripts/…`） | `deny-check.sh` | **直したつもりで直っていない。** リポジトリ側を直しても実際の挙動は変わらず、しかも**何のエラーも出ない** |
| **リポジトリ直接参照**（`python D:/tagtech/.claude/hooks/…`） | `memory_orphan_check.py` | **checkout のブランチに依存する。** その時点の作業ツリーの内容で動くので、ブランチを切り替えるとフックの挙動も変わる。ファイルが `origin/main` に無いまま `main` に揃えると**実体が消えて黙って止まる**（本件で実際に起きかけた。tagtech PR #138 で回避） |

**どちらも「黙って壊れる」。** 一本化の方針は後日決める（2026-09-22 時点では未実施）。
検討時は上の2列（ズレるか / ブランチに依存するか）を比較材料にする。

#### この件で守った手順（再現用）

1. 現行を `deny-check.sh.bak_20260922` として退避（削除しない）
2. **`origin/main` の内容**をコピー（※ 最初は共有 checkout `D:\tagtech` の作業ツリーから
   コピーして**修正前の版を配ってしまった**。`D:\tagtech` は `feat/claude-md-v2` に居たため。
   §8-1-d「判断の前に現在ブランチを確認する」がここでも効く）
3. `settings_file` の行だけユーザー側の値に戻す（この1行だけが2版の差分。
   リポジトリ版は `D:/tagtech/.claude/settings.json`、ユーザー版は `$HOME/.claude/settings.json` を読む。
   混同するとユーザー固有の45パターンが効かなくなる）
4. ロジック部の md5 一致を読み戻しで確認 → 実機で誤検知2件が通り、
   本物の `git push --force` / `bash -c "…"` 経由 / `cat .env` / `rm -rf` は拒否されることを確認

### 7-7. gitignore 化すると、git はそのファイルを守らなくなる（2026-09-23）

**`.gitignore` に入れた瞬間、そのファイルは「ブランチ切り替えで作業ツリーから消えるもの」になる。**

追跡を外す判断をするときに見落としがちなのは、**git が「バックアップ」も兼ねていた**という事実である。
追跡していれば、誤って消しても `git checkout --` で戻せるし、ブランチを切り替えても復元される。
追跡を外すと**その保護が全部消える**。

**実例（2026-09-23）**: `STATUS.md` の追跡を外した（PR #141）直後、`D:\tagtech` を
`git switch -C main origin/main` で main に揃えたところ、**作業ツリーから `STATUS.md` が消えた**。
main では既に追跡対象でないため、git が正しく削除した動作である。

失われかけたもの:

| 内容 | 唯一の保存先だったか |
|---|---|
| **事故ゼロカウンター 96**（`counter_no_incident: 96` / §2 `現在値: 96`） | **はい**。`STATUS.md` のファイル内にしか無い |
| §1 進行中 workstream・§5 次の一手・§6 ヒヤリ注意点・§7 履歴（手書き 306 行） | **はい** |

さらに悪いことに、`status_snapshot.py` は**既存ファイルを読んで一部だけ更新する**作りである
（`original = status_md_path.read_text(...)` → `<!-- AUTO_GENERATED_START -->` 〜 `END` の間だけ置換）。
**ファイルが無い状態で 15 分後の schtask が走っていれば、エラーで止まるか、最悪すべて失われていた。**
社長の指摘で気づき、`git show feat/claude-md-v2:STATUS.md > STATUS.md` で復元した
（復元後の実測: カウンター 96・306 行・`git status` に現れない。12:00 の定時実行後も 96 を維持）。

**チェックリスト（追跡を外す前に必ず確認する）**:

1. そのファイルが **唯一の保存先になっている値**を持っていないか（カウンター・登録簿・手書きの履歴）
2. そのファイルを更新するプログラムは、**全文を作り直す**のか **既存を読んで一部を更新する**のか
   （後者なら、ファイルが無い状態は「再生成される」ではなく「壊れる」）
3. 追跡を外したあと、**git 以外のバックアップ経路**があるか

**「生成物だから gitignore してよい」は、生成物**だけ**が入っている場合にしか成り立たない。**
手書きと自動生成が同居しているファイルは、まず**分離**してから外す。

### 7-3. 「証跡は出ていたが人が見なかった」の実例と対処（2026-09-15〜18）

**仕組みが正しく動いていても、人が見なければ異常は放置される。**

2026-09-15 08:22 UTC、`tagtech-automation` の Deploy が失敗した。以後3日間、
`fetch-depth` の指定漏れで失敗し続けた（§7-1 の5例目）。

証跡層は期待どおり働いていた。実測で確認した。

| 経路 | 実測 |
|---|---|
| notify-gw への記録 | `{"ok":true,"id":300,"discord_sent":true,"suppressed":false}` |
| #alerts への即時通知 | 送信済み（`discord_sent: true`） |
| 日報（Vault `digest/notify-gw-2026-09-15.md`） | `critical: 1` / `e-300` が失敗・CRITICAL 欄に掲載 |

**穴は仕組みではなく運用にあった。** 「日報の CRITICAL 欄を毎朝見る」が
人の注意力に依存しており、1日分の日報は翌日には流れて二度と目に入らない。

#### 対処: 未解消 CRITICAL の持ち越し

「見る」を人に求めるのをやめ、**解消されるまで毎日先頭で繰り返す**形にした。

- 解消の判定は機械が行う（同じ `agent_id`+`action` で `result='success'` が記録されたか）
- **人の「確認済み」操作は設けない。** 人の操作に依存すると、それ自体が忘れられる
- 日報の**先頭**（実行件数より前）に出す。0件なら1行も出さないので、
  出ていること自体が異常のサインになる
- 洪水にしないため `agent_id`+`action` 単位で畳み、上位5件+「他N件」
- **唯一の除外は `agent_id LIKE 'notify-gw/selftest%'`。** Phase1 の受け入れ検証（2026-09-10）で
  CRITICAL 経路の動作を確かめるために意図的に記録した failure（e-2 / e-3）は、後から success が
  来ないので永久に「未解消 CRITICAL: 1件（最古: N日前）」として先頭に居座った。
  **success を後付けで書いて消すことはしない**（起きていない成功を書くのは嘘の証跡。社長判断 2026-09-20）。
  判定側で selftest だけを外す。運用ジョブには一切効かない。除外を増やしたくなったら、
  それは「解消の定義」が足りていない合図なので、まず success が記録される経路を疑う

運用ルールを増やすのではなく、**運用ルールが要らない形に作り替える**のが対処の型。

**実証（2026-09-21）**: 設計どおりに「出て、消えた」最初の実例。

| 時刻(JST) | 証跡 | 何が起きたか |
|---|---|---|
| 04:27 | e-708 CRITICAL | `tagtech-cron/cto-tech-monitor run` — 旧ビルドの本番に `&dry=1` を叩き、未登録ジョブとして失敗（操作ミス） |
| 05:45 | e-713 CRITICAL | 再デプロイ3秒後に同じ URL を叩き、伝播前の旧ビルドが同じ失敗を記録（操作ミス2回目） |
| 05:50 | 日報プレビュー（09-21 分） | 先頭に `── 未解消 CRITICAL: 1件 (最古: 本日) ── … (証跡ID: e-708 ×2回)` — 2件が `agent_id`+`action` で1行に畳まれた |
| 06:01 | e-714 success | 新ビルドの cron が初回実行し `result=success` を記録 |
| 19:20 | 日報プレビュー（09-21 分） | **未解消欄が消えた。** 人は何も操作していない。e-708 は当日の「失敗・CRITICAL」欄には残る（起きた事実は消さない） |

同じ日に、除外条件を入れた `notify-gw/selftest`（e-2）も 09:05 送信の日報から消えている。
**「解消は success の記録で機械が判定する」「人の確認済み操作を設けない」の2つが、
どちらも実データで成立した。** 以後この節を変更するときは、この実例が再現できることを条件にする。

#### 「D1 の送信結果」と「人が #alerts で見た着信」を突合した最初の実例（2026-09-22）

それまで、#alerts に**実際に届いたか**は証跡から判定できなかった（`discord_sent` を保存していなかった）。
migration 0016 とコード側（`8c0c1a7`）の投入後、**社長が #alerts を開いた状態で
selftest の CRITICAL を1件だけ投入し、両側を突き合わせた。**

| 観測点 | 値 |
|---|---|
| events `ts` | `2026-09-22T09:52:35.184Z`（= 18:52:35 JST） |
| events `discord_sent` / `discord_status` | **`1` / `204`** |
| 証跡ID | **e-841**（`agent_id = notify-gw/selftest-discord`） |
| 人が #alerts で見た着信 | **18:52 JST**・本文と証跡ID e-841 が一致・メンション解決済み |
| 未解消 CRITICAL 欄 | **出ない**（`notify-gw/selftest%` 除外が効いている） |
| 日報「失敗・CRITICAL」欄 | e-841 が出る（起きた事実は消さない設計どおり） |

**これで観点C（#alerts と日報の内容が一致するか）は、人の記憶ではなく証跡で判定できるようになった。**

**同時に判明した限界（隠さず記録する）**:

1. **`ts` は events に INSERT した時刻であって、Discord への送信完了時刻ではない。**
   送信は INSERT の直後に行われる（実測1秒以内）ので実用上ずれないが、
   **「送信に何秒かかったか」は現在のスキーマからは測れない。**
   #alerts の遅延を問題にするときは列を追加する必要がある
2. **送信が失敗したとき（`discord_sent=0`）に日報へ「#alerts送信失敗: N件」が出ることは、
   本番では実証していない。** Webhook を壊す必要があるため。ユニットテスト
   （`event.test.ts` の 400 応答ケース・`digest.test.ts` の表示 ON/OFF）で固定してある
3. **Discord に届いたことと、端末が鳴ったことは別である。** この検証で確かめたのは前者まで。
   端末の通知設定が落ちていれば、2026-09-15 の「3日間気づかれなかった」と同じ構造が残る

#### 翌日の日報で、観点C が「証跡で判定できる」ことを確認した（2026-09-23）

上の突合は**意図的に投入した selftest** での実証だった。翌日（並走検証2日目・09-22 分の日報）に、
**運用の流れの中で同じ判定が成立すること**を確認した。

| 観点 | 1日目（09-22 記入・09-21 分） | 2日目（09-23 記入・09-22 分） |
|---|---|---|
| C #alerts と日報の一致 | **検証不能**（#alerts 本文を読む手段が無く、`discord_sent` も未保存） | **✅ 判定可能**（e-841 の `discord_sent=1` / `discord_status=204` と、人が見た着信 18:52 JST が一致） |
| 判断1（Vault の集計軸） | Vault 43件 vs Discord 15件で**不一致** | **一致**（Vault `設計上の誤り 15 件（タスク数）` = Discord `15 件`） |
| 「#alerts送信失敗」欄 | 機能自体が未実装 | **出ない**（当日の CRITICAL 1件が送信成功のため。0件時は非表示という設計どおり） |

**この節を書き換えるときは、この「1日目に検証不能 → 当日中に穴を塞ぐ → 翌日に実証」の流れが
再現できることを条件にする。** 並走検証は「仕組みが緑か」ではなく「**落ちた項目がその場で塞がれ、
翌日に実測で確認されるか**」を見るために置いている。

#### Phase 6 の1週間並走検証に含める項目

検証するのは仕組みだけではない。**人がその出力を実際に見ているか**も検証対象にする。

| 検証項目 | 見かた | 落ちたときの意味 |
|---|---|---|
| **日報の CRITICAL 欄を人が見ているか** | 日報に出た CRITICAL が、翌営業日までに対処または起票されているか | 見ていない。**通知を増やすのではなく、持ち越しのように「見なくても効く」形へ作り替える** |
| 未解消 CRITICAL の持ち越しが機能するか | 意図的に CRITICAL を出し、success を記録するまで毎日出続けることを確認 | 解消判定の SQL か配線の不具合 |
| #alerts と日報の内容が一致するか | 同じ事象が両方に出ているか | どちらかの経路が欠けている |

**実例（2026-09-15〜18）**: Deploy 失敗が #alerts にも日報にも出ていたが、
**3日間誰も気づかなかった**。仕組みは全て緑だったので、仕組みの検証だけでは
この失敗は検出できない。「人が見たか」を明示的に検証項目に入れる理由がこれである。

## 8. 旧 Python 実装を Workers へ移植する標準手順

2026-09-14 に判明した構造: `tagtech-automation` の cron タスクは日本語の指示文を
LLM に渡すだけで、LLM は「その仕組みの作り方」の解説文を返していた。一方で
対応する Python 実装は `D:/tagtech/scripts/` に存在し、schtasks はほぼ全て Disabled。
つまり **Cloudflare 移行時に Python 側を止めたが、移行先が LLM プロンプトだったため
業務が消えていた**（2026-04-20 の n8n 移行事故と同型）。

移植先は **Cloudflare Workers** とする。schtasks の恒久的な再有効化はしない
（ローカル常駐は n8n 移行時の全 Disable・WSL2 アイドル停止・今回の Disabled 放置と
3回止まっており、「Cloudflare = 実行ハブ」の原則にも反する）。

### 8-0. 全 Worker の共通要件: ジョブを実行しない認証確認ルートを持つ

**すべての Worker は `/health`（または `&dry=1`）を必ず持つ。**
要件は次の3つ:

- **X-Run-Key 認証あり。** 鍵なし → 403 / 正しい鍵 → 200。認証判定より**後**に置く
- **ジョブを実行しない。** 外部への書き込み・送信を伴わない
- 返すのは `{ok:true, ...}` 程度でよい（存在と認証が確かめられれば足りる）

**なぜ要件にするか**: これが無いと、鍵やデプロイを確かめる手段が「本番実行」しか無くなる。
2026-09-21 までに**同型の誤操作が3回**起きた:

| 証跡 | 何を確かめようとして | 何が起きたか |
|---|---|---|
| e-708 | 本番のビルド世代 | 旧ビルドが `&dry=1` を知らず、未登録ジョブとして CRITICAL を記録 |
| e-713 | 再デプロイの反映 | 伝播前の旧ビルドが応答し、同じ CRITICAL をもう1件 |
| e-780 | 鍵ファイルの CR 除去 | `vault-intel` に確認口が無く `/run` を叩き、HN 収集ジョブを1回余計に実行 |

3回とも「叩く前に何が起きるか確認する」という**個人の注意**で防ぐ話にしていた。
注意で3回防げなかったので、**構造**（確認口を必ず持つ）で対処する。

現状（2026-09-21）: notify-gw `/health` / growth-collector `/health` / tagtech-cron `&dry=1` /
vault-intel `/health`（tagtech PR #101 で追加）。**4 Worker すべてが要件を満たす。**

新しい Worker を作るとき・既存を移植するときは、**最初のコミットで `/health` を入れる**。

### 8-1. 手順（1件ずつ・1コミット1タスク）

0. **タスク定義と実装が同じ業務を指しているか確認する。**（最初にやる。ここで落ちたら以降は無意味）

   cron のタスク定義文（`prompt`）と、実装スクリプトが実際にしていることを**別々に読んで突き合わせる**。
   定義文は「そのタスクが何をすることになっているか」の宣言でしかなく、**実装の要約ではない**。
   移植とは実装を移すことなので、ここがズレていると「定義に書いてある業務」は
   どこにも存在しないまま、別の業務が Workers へ運ばれる。

   確認するのは3点:
   - **動詞が一致するか**（「通知する」と書いてあるのに実装が「書き込む」なら別業務）
   - **入出力が一致するか**（「本日予定を取得」と書いてあるのに実装が固定リストを持っているなら別業務）
   - **その業務が現在の運用ルールに反していないか**（実装当時のルールと今のルールは違う）

   **実績（2026-09-18 時点で2件。いずれも移植を中止した）**

   | タスク | 定義 | 実装 | 結末 |
   |---|---|---|---|
   | `hn_trends_morning` | HackerNews トレンド取得・Discord 通知 | LLM が「HN 取得の仕組みの作り方」の解説文を返していた。記事一覧を取得していない | 実体なし |
   | `google_calendar_sync` | Google カレンダー同期・**本日予定を Discord 通知** | 固定リスト26件の繰り返し予定をカレンダーへ**書き込む**。Discord 通知も本日予定の取得も無い。26件中21件が AI 自動タスクで運用ルール違反 | 廃止降格 |
   | `cio_daily_news` | 日次ニュース**収集**・Discord 通知 | 外部ニュース source を1つも持たず、**LLM に「今日のニュースをまとめて」と聞くだけ**。収集工程が存在しない | 廃止降格（§8-1-b） |

   一致しない場合は**移植しない**。「定義どおりの業務」が必要なら、それは移植ではなく**新規設計**である。

   **4件目は cron タスクではなく GitHub Actions だった（2026-09-22・`auto_backup.yml`）。**
   「自動バックアップ（毎時）」は導入（`cb799cc`・2026-04-16）から**5か月間 success を返し続けたが、
   コミットを1件も作っていなかった**。設定した identity（`TagTech-Bot <bot@tagmetech.com>`）の
   コミットは全 ref 横断で **0 件**。直近15回の run はすべて success（8〜14秒）だが
   「変更あり」ステップは毎回 skip（`BACKUP_STATUS=no_changes`）。

   原因は実装の不在ではなく**設計の不成立**: runner は毎回クリーンな checkout をするので
   `git status --porcelain` が常に空で、**バックアップ対象だった「ローカルPCの未コミット差分」は
   runner からそもそも見えない**。履歴に残る `[AUTO]` コミット27件は別経路（ローカルの
   `scripts/auto_commit.py`）の産物で、この workflow とは無関係だった。

   **この系統は「定義と実装の不一致」より検出が難しい。** 実装は定義どおりに書かれており、
   読んでも矛盾が無い。破綻するのは**実行環境と対象の関係**で、それは動かしてみても
   `success` としか出ない。したがって疑うべきは実装文ではなく**「その成果物が実在するか」**である:
   バックアップなら「コミットが実在するか」、収集なら「取得した記事が実在するか」。
   `hn_trends_morning`（解説文を返すだけで記事0件）と同じ問いの立て方が効く。

   対処（tagtech PR #132）: `schedule` を外し、理由を yml 冒頭に記録。削除はしない。
   **未解決のリスクも yml に明記した** — この workflow が止まっていた間もローカルの
   未コミット変更（2026-09-22 時点で76件）はどこにもバックアップされておらず、
   workflow を戻しても解決しない。

   **3件続いたので、これは例外ではなく既定で疑うべき状態である。** タスク定義文は
   Cloudflare 移行時に人が書いた宣言で、実装を読んで書かれたものではない。

### 8-1-b. `cio_daily_news` の出力検証と、配信済み分の扱い

`logs/cio_intelligence_report.json` に残っていた30件（**2026-05-29 〜 2026-07-06**）を、
証跡層と同じ基準（出典 URL ≥ 1 または独立数値 ≥ 3）で判定した。

| 判定 | 件数 | 本文の長さ |
|---|---|---|
| 出典 URL あり（Gemini Grounding が効いた） | **11件** | 1,500〜4,738字 |
| **出典ゼロ（LLM の記憶からの生成）** | **19件** | 342〜1,609字 |

**30件すべてが `status=success`。** 成否では区別できない。出典の有無は本文長にほぼ対応し、
短い回はすべて出典ゼロだった。

2026-07-06 分（出典ゼロ）には「Anthropic は Claude 3.5 をリリース」
「Google は Gemini 1.5 のマルチモーダル API をベータ提供開始」とあるが、いずれも **2024年**の
出来事である。同じ回で「今週発表の**4月**小売売上高」とあり、7月のレポートとして日付も合わない。
履歴全体で「2026年における予測シナリオ」という語が3回現れ、LLM 自身が予測と自認して
書いている回もある。

**ニュース記事の体裁で、具体的な数値と固有名詞を伴う作り話**であり、
`hn_trends_morning`（解説文が返るので一目で分かる）より見分けにくい。
2026-05-11 に発覚した「作り話68件」と同じ構造が、この時点まで残っていた。

> **注釈（消さない・隠さない）**
> **2026-05-29 〜 2026-07-06 に配信された CIO 日次ニュース30件のうち、19件は出典がなく、
> LLM の記憶から生成された内容である。**実在しない企業名・確認できない数値・
> 2年前の出来事を「最新ニュース」として含む。これらを事実として引用してはならない。
>
> `cio_intelligence.py` の `main()` は `--no-discord` が無い限り `send_to_discord()` を呼び、
> 登録定義（`AI_CIO_Intelligence`）の引数は `daily` のみなので、**既定で配信される経路**だった。
> ただしレポート JSON に送信結果のフィールドが無いため、**個々の回が実際に Discord に
> 届いたかはファイルからは確定できない**。確定するには当該期間の Discord チャンネル履歴を見る。

履歴には実在確認が必要な固有名詞（企業名・人物名らしき語）が含まれるため、
**成果物・外部公開物には引用しない**。本 RUNBOOK にも具体名は転記していない。

#### 同じ構造のタスクが他にないか（全件走査・2026-09-18）

`enable_web_search=True` は `ai_client` 内で **Gemini のときだけ** Grounding を有効化し、
フォールバック先（OpenRouter / Groq / Claude CLI）では**無視される**。
`public` / `confidential` どちらのルートにも `gemini` が含まれるため、
このフラグを使うコードは常に「Gemini が通れば本物、落ちれば作り話」になる。

`scripts/` 全体を走査した結果、このフラグを使うのは **2本のみ**。

| スクリプト | 用途 | リスク |
|---|---|---|
| `cio_intelligence.py` | **LLM に外部事実を生成させる** | **該当。降格** |
| `daily_standup.py` | 各エージェントの報告文（呼び出し側が渡す）を要約 | 入力が与えられているのでフラグは実質無意味。外部事実は問うていない |

さらに「LLM に最新の外部事実を問う」プロンプトを広く走査したが、
`finance_news.py` / `finance_content.py` は実際にニュース一覧を取得してから LLM に渡しており
（`news[0]["title"]` を参照）、構造上は正しい。どちらも `cronToTasks` には登録されていない。

**結論: この構造を持つ cron タスクは `cio_daily_news` 1件のみ。**

1. **移植前の動作確認。**「実装がある」と「今も動く」は別である。Python 実装は
   5ヶ月停止しているので、1本ずつ次を確認する:
   - 依存パッケージが揃うか（CFO レポートの `filelock` 欠落と同型の事故）
   - API トークン・認証情報が有効か（`CLOUDFLARE_API_TOKEN` 4ヶ月失効と同型）
   - 呼んでいる外部 API の仕様が変わっていないか（プロパティ名が今も取れるか）
2. **まず送らずに中身だけ抽出する。** **出力の質が未検証の段階で Discord に送らない**
   （1件なら実害は小さいが、17件すべてで同じことをすれば17通になる）。

   **標準の実行方法は `&dry=1`**（2026-09-18 に tagtech-cron へ恒久化）。
   毎回 Discord 送信関数を差し替えるのではなく、手動実行の口で切り替える。

   ```
   curl -sS -H "X-Run-Key: $(cat D:/tagtech/cloudflare/tagtech-cron/.run-key.txt)" \
     "https://tagtech-cron.bb25xp.workers.dev/?job=<ジョブ名>&dry=1"
   ```

   **tagtech-cron の手動実行鍵の所在: `D:\tagtech\cloudflare\tagtech-cron\.run-key.txt`**
   このファイルは `.gitignore` の対象なので **worktree には複製されない**。
   worktree から使うときは上の**絶対パス**で参照する
   （相対パスで書くと worktree では存在せず、鍵が無いように見える）。
   値は画面に出さず、`$(cat ...)` / `Get-Content` で直接渡す。

   `dry=1` は `runJob` を通さないので、**Discord にも証跡にも出ない**。
   応答に `level` / `summary` / `expect` / `evidence_url` / `text_preview` / `meta` が並ぶ。

   **抑止されるのは「報告」だけで、ジョブ本体の処理は実際に走る。**
   移植したジョブは §8-1-c により真実源に書かない設計なので通常は読み取りのみだが、
   外部へ書き込むジョブに使えば書き込みは起きる。

   確認するのは次の3点:
   - `text_preview` に**実際のデータ**が入っているか（解説文・定型文でないか）
   - `expect=external_data` なら URL か検証可能な数値を含むか（`evaluateExpectation` の基準）
   - `level` が実態と合っているか（判定不能を ok と言っていないか）
3. 良ければ送信込みで Workers に実装する
4. 実装したら `expect` を `deterministic` → `external_data` に切り替え、
   **日報の「設計上の誤り」件数が1つ減ることを実データで確認してから次へ進む**
5. 外部データを扱うものは `evidence_url` に取得元（API URL 等）を必ず残す
6. **`cronToTasks` / `CRON_MAP` を変更したら、台帳の seed を作り直す。**
   cron の降格・移植はどちらかを必ず変えるので、**移植手順の一部として毎回実行する**。
   忘れると `job_schedule`（＝期待値の真実源）が実態とズレ、自律度が誤って測られる。
   実例: 2026-09-14 に tagtech-cron で6本降格したが seed が再生成されず、
   09-21 の再生成まで `job_schedule` に残り続けていた。

   **本体 `D:\tagtech` を pull せずに作る（2026-09-21 確立）。** 本体は別セッションが
   未コミット変更やステージ済みリネームを抱えていることがあり、pull は停止条件に当たる。
   スクリプトも本体の `chore/claude-devops-setup` には無く `origin/main` にしか無い。
   clean な一時 worktree を切り、環境変数で読み取り元を差し替える（tagtech PR #78）。

   ```bash
   # 1) 一時 worktree(いずれも detach・既存の作業ツリーには触れない)
   git -C /d/tagtech-task-dedupe-cron worktree add --detach /d/tagtech-seed-main origin/main
   git -C /d/tagtech-task-dedupe-cron worktree add --detach /d/tagtech-seed-base origin/chore/claude-devops-setup
   git -C /d/tagtech/projects/tagtech-automation-guard worktree add --detach /d/tagtech/projects/tagtech-automation-seed origin/master
   git -C /d/tagtech/projects/notify-gw-model-watch worktree add -b feat/job-schedule-seed-YYYYMMDD /d/tagtech/projects/notify-gw-seed origin/main

   # 2) tagtech@main の checkout から実行(data/*.json・role_registry.py は REPO_ROOT 相対のため)
   cd /d/tagtech-seed-main
   PYTHONUTF8=1 \
   AGENT_LEDGER_TAGTECH_DIR=/d/tagtech-seed-base \
   AGENT_LEDGER_AUTOMATION_DIR=/d/tagtech/projects/tagtech-automation-seed \
   AGENT_LEDGER_NOTIFY_GW_DIR=/d/tagtech/projects/notify-gw-seed \
   AGENT_LEDGER_OUT_DIR=/d/tagtech/projects/notify-gw-seed \
   python scripts/agent_ledger_export.py --check     # まず差分を見る
   python scripts/agent_ledger_export.py             # 生成
   ```

   **適用済み migration は書き換えない。差分は新しい番号で出す。**
   exporter は `0005` / `0010` を in-place で上書きするが、どちらも本番適用済みで、
   wrangler はファイル名で適用済みを管理する。**中身を変えても本番には二度と流れず、
   git と本番が黙って乖離する。** 生成物の `job_schedule` 行を
   `migrations/00NN_job_schedule_refresh_YYYYMMDD.sql`（`DELETE FROM job_schedule;` + INSERT）へ
   写し、`0005` / `0010` の変更は `git checkout --` で捨てる（実例: 0014）。
   `agent_ledger` は batch_id 付きの履歴テーブルなので「新 batch_id で追加」が筋
   （exporter 側の対応は所管セッションと調整中）。

   差分の読み方: `source` 列の行番号は index.ts が伸びるだけで変わる。**行番号を潰してから
   集合差を取る**（`sed 's/index.ts:[0-9]*/index.ts:N/'` → `comm`）。生の `git diff` では
   全行が変わって見え、実質の増減が読めない。

   出したものは**ローカル D1 で適用して読み戻す**（`wrangler d1 migrations apply --local` →
   `SELECT COUNT(*) FROM job_schedule` と、増減したはずの job_id を個別に確認）。
   生成物は手編集しない。直すなら生成元を直して再生成する。
7. 動かしたタスクの出力は **Vault に全文を残す**（日報は1行集約のまま）。
   3〜7日運用してから「業務に使えるか／他系統と重複しないか／継続する価値があるか」を判定する

### 8-1-b-2. 【解消済み】本番デプロイは CI 経由が既定。手元デプロイは例外手順

**2026-09-21 に解消。** 全 Worker の本番デプロイは **`main` への push（= PR のマージ）で
CI が実行する**のが既定であり、**手元 `wrangler deploy` は下記の例外手順に降格した**。

| Worker | workflow | トリガ | デプロイ前の検査 |
|---|---|---|---|
| notify-gw | `notify-gw/.github/workflows/deploy.yml` | `main` への push（`src/**`・`wrangler.jsonc` 等）/ `workflow_dispatch` | `typecheck` + `test` |
| tagtech-cron | `tagtech/.github/workflows/deploy_tagtech_cron.yml` | `main` への push（`cloudflare/tagtech-cron/**`）/ `workflow_dispatch` | **predeploy 4検査** |
| vault-intel | `tagtech/.github/workflows/deploy_vault_intel.yml` | `main` への push（`cloudflare/vault-intel/**`）/ `workflow_dispatch` | **なし**（`package.json` 無しのプレーン JS。読み戻しが唯一の検証） |
| growth-collector | `tagtech/.github/workflows/deploy_growth_collector.yml` | `main` への push（`cloudflare/growth-collector/**`）/ `workflow_dispatch` | `typecheck` + `test` |
| tagtech-automation | `tagtech-automation/.github/workflows/deploy.yml` | `master` への push | `check:bindings` + `test` |

**2026-09-21 時点で、本番稼働している Worker はすべてこの表に載っている。**
新しい Worker を作ったら、**最初の PR で deploy workflow も一緒に出す**
（後回しにすると「main にコードはあるのに本番に出ていない」状態が生まれる。
実際 vault-intel の `/health` は PR #101 でマージしたのに、配る経路が無く
本番は 404 のままだった）。

各 workflow は **secret の空チェック → テスト → デプロイ →
認証前の応答が 403 であることの読み戻し → 証跡送信** を順に行う。
`concurrency` で同時デプロイを禁止し、`cancel-in-progress: false`（走っているデプロイを殺さない）。
**D1 マイグレーションは CI では流さない**（適用は人が §8-1-d の手順で行う）。

初回稼働の実測（2026-09-21）:

| | notify-gw | tagtech-cron | vault-intel | growth-collector |
|---|---|---|---|---|
| Deploy 結果 | `completed success` | `completed success` | `completed success` | `completed success` |
| Version ID | `e9d88a57-7e78-4e0e-8945-f0eb7dea841e` | `b9c765ae-01fc-4193-a05a-0ec71af7550a` | `4dab0b75-dff9-4e68-8aa6-d1bfecd270ce` | `0565c18f-52ee-4c5e-94ed-bca9b9e35f03` |
| workflow 内の読み戻し | `attempt 1: HTTP 403` | `attempt 1: HTTP 403` | `attempt 1: HTTP 403` | `attempt 1: HTTP 403` |
| 本番の独立確認 | `/health` 鍵なし 403 / 正鍵 200 | `&dry=1` 正鍵 200 | `/health` 鍵なし 403 / 正鍵 200（`{"ok":true,"worker":"vault-intel"}`） | `/health` 鍵なし 403 / 正鍵 200 |
| 証跡 | e-778 | e-779 | **e-781** | **e-782** |
| デプロイ前の検査 | typecheck + test | バインディング3件 / CRON_MAP⇔crons 16件 1:1 / origin/main にマージ済み / テスト全件 すべて ✓ | （なし） | typecheck + test 52件 PASS |

**Deploy が失敗したら、手元デプロイで回避しない。** 原因を報告し、承認を得てから動く。
CI を迂回した時点で「誰がいつ何を配ったか」が再び追えなくなり、§8-5 の巻き戻し事故に戻る。

#### 例外手順（CI が使えないときだけ・毎回社長承認）

CI が落ちている・Actions が使えない等で**どうしても手元から配る必要がある場合のみ**、
以下を全て通してから承認を求める:

1. `main`（または base）を `pull --ff-only` し、**対象コミットが HEAD にあることを確認**
   （`--rebase` マージでは SHA が変わるので、SHA ではなく**内容**と**コミット件名**で見る）
2. `npm test` 全件 PASS
3. `wrangler deployments list` で**直近30分に他セッションのデプロイが無い**ことを確認
   （自分が直前に行ったデプロイは対象外。Version ID で見分ける）
4. **本番に在って手元に無いコードが無いか**を確認する（巻き戻し防止）
   ```
   git fetch --all
   git log --all --oneline --not HEAD -- <デプロイ対象のディレクトリ>
   ```
   base にマージされていないブランチのコミットが出たら、その中身が本番に
   配られていないか疑う。**「本番稼働中コードの保全」のような wip コミットは
   特に危険**（本番に在るがどのブランチにも取り込まれていない状態を意味する）。
5. デプロイ後、**変更点を読み戻して確認**する
   （ルートの追加なら、認証前の応答が 404 から 403 に変わることで存在を確かめられる。
   未実装なら 404、存在して要認証なら 403 になる）

**実例（2026-09-18）**: この確認をせずに tagtech-cron をデプロイし、
`71a126b`（wip ブランチのみに存在）で追加されていたバインディング自己申告を
**本番から消した**。notify-gw は正しく `binding-report-stale` を出し続けたが、
2日間気づかれなかった。`git log --all -S'bindings/report'` で全ブランチを
横断検索して初めて原因が分かった。

**実例2（2026-09-20・逆方向の巻き戻し）**（ルール本文は §8-5「Worker の本番デプロイ元は `main` だけ」。ここは実例の記録）: 11:56Z に `chore/claude-devops-setup`（e16d8d8）から
デプロイした 3c0889ce（バインディング自己申告の復元・cto-tech-monitor・task-pipeline・`&dry=1`）が、
12:40Z に **`main` から行われた別セッションのデプロイ（cf07356a・PR #69 funding-reminder の
DEADLINES 除去）で上書きされた**。翌日 `?job=cto-tech-monitor&dry=1` を叩いて旧応答
（「実行しました…Discordを確認」）が返ったことで発覚。`wrangler versions view` は
バインディング・secret 名しか見せないため、**コードの世代は「そのビルドにしか無い振る舞い」
（未認証時 403 になる新ルート、`dry=1` の応答形式など）で読み戻す**しかない。

根本原因は手順の不備ではなく、**`cloudflare/tagtech-cron` を `main`（PR #60 で取り込み）と
`chore/claude-devops-setup`（移植作業の base）の2ブランチが別々に持ち、双方からデプロイして
いたこと**（§7「真実源は1つ」違反）。手順4の `git log --all --not HEAD` は今回も
`main` 側の4コミット（funding-reminder）を正しく列挙していた。**列挙されたら「別ブランチに
同じディレクトリの真実がある」と読み、デプロイせず先にブランチを1本化する。**
1本化するまで、この Worker はどちらのブランチからデプロイしても相手側を消す。

### 8-1-c. 真実源に書き込むのは人間だけ。Worker は読んで報告するのみ

**移植したジョブが真実源のデータを書き換えてはいけない。** Worker がしてよいのは
「読む」「集計する」「報告する」「証跡を残す」までで、業務データの追加・更新・削除はしない。

2026-09-18、`monthly_fixed_expenses`（毎月1日に固定費を自動計上する）の移植で
この原則を決めた。Python 版は `finance/ledger.json` に自動で行を足していたが、
真実源を Notion「収支台帳」へ移したあと同じことをすると、次の問題が起きる。

- **二重計上を止められない。** cron が2回走れば2行入る。Worker 側に冪等性を作り込んでも、
  人が同じものを手で入れれば重複する。台帳の正しさを機械と人で分担できない
- **誤りに気づけない。** 自動で入った行は、人が「自分が入れた覚えがない」と思わない限り
  検算されない。`cio_daily_news` の作り話が19件積み上がったのと同じ構造
- **訂正の責任が曖昧になる。** 台帳は会計の記録で、最終的な責任は人が負う

したがって `monthly_fixed_expenses` の移植先は**自動計上ではなく「今月の固定費が
未入力です」という通知**にする。判断と記入は人が行い、Worker は漏れを指摘するだけにする。

例外は**証跡層自身**（`events` / `binding_reports` / `digest_log`）。これは
「Worker が何をしたか」の記録であり、業務データではない。人が書く対象でもない。

### 8-1-d. D1 migration の本番適用手順（`main` の clean な checkout から）

PR がマージされた migration を本番 D1 に流す手順。**worktree のブランチから直接は適用しない**
（PR → マージ → `main` を pull → 適用、の順。マージ前の SQL を本番に流すと git と本番が乖離する）。

**実行者の分担（§6-3 手順4 と同じ。ここでも明記する）**: 手順3 の
`wrangler d1 migrations apply --remote` は **社長が自分の手で実行する。AI セッションからは実行しない。**
AI セッションがやるのは、手順1（起点の確認）・手順2（未適用一覧の提示）・**手順4（読み戻し）**まで。
読み戻しの `SELECT` は `--remote` でも AI セッションが実行してよい（読み取りのみ）。
読み戻しの期待値は**適用前に宣言しておく**（「適用した」という報告だけを信じない。§7-1 実例3）。

```bash
cd D:/tagtech/projects/notify-gw
# 1. 起点が main の先端であることを先に確かめる（ここを飛ばすと 2〜4 がすべて「正常」に見えたまま外れる）
git switch main && git pull --ff-only && git log --oneline -1
git rev-parse HEAD origin/main            # 2行が同じ SHA であること
git status --short                        # 空であること
# 2. 未適用の一覧に、いま流したい番号「だけ」が出ること
npx wrangler d1 migrations list notify-gw --remote
# 3. 適用
npx wrangler d1 migrations apply notify-gw --remote
# 4. 読み戻し（件数・存在・値。migration ごとに「何が変わるはずか」を先に書いてから叩く）
npx wrangler d1 execute notify-gw --remote --command "SELECT COUNT(*) FROM job_schedule"
```

**手順1を最初の1行にした理由（実例・2026-09-20〜21）**: migration `0014`（`job_schedule` の
入れ替え）をマージ後、`D:\tagtech\projects\notify-gw` で `git pull --ff-only` を実行すると
`aa90bf4..bfd4c5f main -> origin/main` を fetch したのに **「Already up to date」**、
`migrations list --remote` は **「No migrations to apply」**、`SELECT COUNT(*) FROM job_schedule` は
**63（期待 53）**だった。原因は、このディレクトリの checkout が RUNBOOK 編集のために
`docs/auth-expiry-history` へ切り替えられたまま `main` に戻されていなかったこと。
作業ツリーはクリーンでブランチも push 済みだったため、`git switch main` →
`git pull --ff-only`（`5a2ca5b..bfd4c5f`）→ 適用 → `COUNT(*)=53` の読み戻しで解消した。

3つの出力はどれも嘘をついていない（docs ブランチは確かに最新で、そのブランチの
`migrations/` に 0014 は無い）。**「正常な出力の組み合わせが、前提（main を見ている）が
崩れていることを隠す」**典型なので、前提の確認を手順の先頭に置く。
§7-1 の実例3（2026-09-15・apply だけが効いていなかった）とは別の型で、
どちらも「読み戻しの期待値（53 / 22→0）を先に決めていたから気づけた」点は同じ。

**2例目（2026-09-22・migration ではなくソースの有無を誤認）**: `cloudflare/growth-collector/`
を見て「ソースが `main` に取り込まれていない」と報告したが、**誤りだった**。
`main` には `src/` も `package.json` も `wrangler.jsonc` も揃っており、
**`D:\tagtech` の checkout が `chore/claude-devops-setup` のままだった**だけである。
1例目（0014 が見えなかった）と同型で、**見ているブランチが違うのに、出力そのものは正しい**。

**判断の前に `git branch --show-current` を確認する。**
共有 checkout（`D:\tagtech` / `D:\tagtech\projects\notify-gw`）で
「無い」「古い」「適用されていない」と判断しかけたら、まずこの1行を挟む。
`ls` も `git ls-tree` も `git pull` も、**そのブランチについては正直に答える**ので、
出力を何度見直しても前提の誤りには気づけない。

### 8-1-a. 証跡の出し方（移植16件すべてで守る契約）

**ジョブ側で `postEvent` を呼んではいけない。** `runJob` が全ジョブ共通で証跡を出すため、
ジョブ側でも出すと1回の実行で2件記録され、自律度の分母が狂う
（2026-09-15 に `pipeline-daily` で実際に発生。e-278 / e-279）。

証跡に載せたい情報は **`JobResult` に入れて返す**。`runJob` が `postEvent` へ渡す。

| `JobResult` のフィールド | 用途 |
|---|---|
| `evidenceUrl` | 取得元（API URL 等）。外部データを扱うものは必ず入れる |
| `expect` | `external_data` / `deterministic` / `none`。notify-gw が機械判定する |
| **`textPreview`** | **実体判定の対象になる本文。** 中身のある出力は必ずここに入れる |
| `meta` | 証跡へ載せる補足 |
| `resultOverride` | 送信を抑制した等の理由で `success` ではなく `skip` を申告したいとき |

**`notify-gw` の実体判定は `meta.text_preview` を見る。** `runJob` は `textPreview` を
この名前に詰め替える。**別名（`report_body` など）で送ると判定対象にならず、
フォールバックで短い `target` が判定されて「実体なし」と誤判定される。**

2026-09-15 の実害: 340 字の本文があるのに `target`（19 字の要約）が判定され、
`ok: false / no_verifiable_facts / length: 19` になった。判定ロジックは正しく、
**契約が文書化されていなかったことが原因**。

送信を抑制した場合も**証跡は必ず残す**。`resultOverride: "skip"` と
`meta.suppressed` / `meta.suppress_reason` を載せ、「送っていない」のか
「実行していない」のかを後から区別できるようにする。

### 8-2. 着手順は「ローカル状態への依存」で決める

Workers にファイルシステムは無い。`D:/tagtech/data/*.json` を読み書きするものは
D1/KV への置き換え設計を伴うので後回しにし、**状態が Notion / 外部 API 側にあるものから**着手する。

#### 8-2-a. 依存の「有無」ではなく「種類」で判断する（2段階の分類）

「依存あり／なし」の1軸だけでは着手順を誤る。`pipeline_report.py` は依存ありだったが
**依存先がログファイル1本だけ**だったので実際には何の設計も要らなかった。
検出したパスは必ず次の種別に振り分ける。

| 種別 | 例 | 移植方針 |
|---|---|---|
| **業務状態** | `finance/ledger.json` / `data/sales_pipeline.json` / `stream/stream_data.json` | **D1/KV への移行設計が必要。** ここがある限り後回し |
| **出力キャッシュ** | `data/revenue_dashboard.json` / `logs/*_report.json` | **用途を個別判断。** 毎回再計算できるなら捨てる。他プロセスが読むなら移行先が要る |
| **実行ログ** | `logs/*.log` | **移植時に落としてよい。** 証跡層（`events`）と `wrangler tail` で代替される |
| **設定/資格情報** | `.env` / `token.json` | Workers の secret に置換。状態ではない |
| **出力物** | `stream/overlay.html` | 誰が読むかで判断（OBS が読むならローカルに残す必要がある） |

判定は `logs/` 配下かどうかではなく**拡張子で見る**。`logs/ciso_security_report.json` は
置き場所がログディレクトリなだけで中身はレポート出力であり、落とすと機能が消える。

#### 8-2-b. 検出は正規表現ではなく AST で行う

**Python のパス構築は書き方が無限にあり、正規表現にパターンを足す方式は破綻する。**
2026-09-15、同じ分類で**4回続けて取りこぼした**:

| 回 | 対応したつもりの形 | 落としていた形 | 結果 |
|---|---|---|---|
| 1 | `"data/x.json"` 文字列リテラル | `ROOT / "data" / "x.json"`（pathlib） | 依存を見落とし |
| 2 | + pathlib 形式 | `os.path.join(BASE, "finance", "ledger.json")` | `revenue_dashboard` を「依存なし」と誤分類 |
| 3 | + `os.path.join` 形式 | 変数経由（`LEDGER_PATH` のような定数を挟む形） | 見えないまま |
| 4 | — | `Path(__file__).parent.parent / "stream" / ...` | `notion_sync.py` を「依存なし」と誤分類 |
| 5 | AST 化したが1ファイルしか見なかった | **`import` 経由**（`from cfo_finance import add_entry`） | `monthly_fixed_expenses` を「I/O ゼロ」と誤分類 |

正しい方式は **`ast` モジュールでの構文解析**:

1. `ast.parse()` し、`ast.Call` を走査して `open` / `Path.read_text` / `json.load` /
   `os.path.exists` / `shutil.copy` 等の**ファイル I/O 呼び出しそのもの**を拾う。
   パスの位置は呼び出しの形で違う（組み込み・モジュール関数は第1引数、Path のメソッドはレシーバ）
2. モジュールレベルの定数代入を**先に収集して解決**する。実スクリプトはほぼ全て
   `LEDGER_PATH = os.path.join(BASE, ...)` の形なので、これが無いと全件「パス不明」になる
3. **`import` を再帰的に追う。** `scripts/` 配下の自作モジュールを import している場合、
   その先の I/O も自分の依存である。`monthly_fixed_expenses.py` は直接 I/O が
   **1件も無い**のに、`cfo_finance.add_entry()` 経由で `finance/ledger.json` に書く
4. 解決できないものは**「パス不明の I/O あり」として人の確認に回す**（握りつぶさない）
5. **検出漏れより過剰検出に倒す。** 見落としは「移植が容易」という誤判定を生み、
   着手してから D1/KV 設計が必要と分かる。過剰検出は人が1件見れば消える

`root` がモジュール（`os` / `shutil` / `json` …）かどうかを見ないと、
文字列の `.replace()` や dict の `.copy()` を I/O と誤検出する。ここだけは絞る。

#### 8-2-c. 分類結果（2026-09-15・AST + import 追跡版）

| 区分 | 件数 | 内容 |
|---|---|---|
| ファイル I/O ゼロ | 1 | `google_calendar_sync`（資格情報も環境変数経由。**唯一の無条件候補**） |
| ログ・設定のみ | 1 | `pipeline_daily`+`pipeline_weekly`（**移植済み**。依存は `logs/*.log` と `.env` のみ＝落としてよい種別だけ） |
| 出力キャッシュのみ | 3 | `cio_daily_news` / `ciso_security_scan` / `cto_tech_monitor` |
| **業務状態あり（後回し）** | 11 | 最も重いのは `cfo_monthly_report` / `revenue_dashboard`（`revenue_dashboard.py` 経由で業務状態5件が芋づるで付く） |

`ciso_security_scan` は出力キャッシュのみだが `os.walk()` でリポジトリのファイルを
走査するため、**そもそも Workers に持っていけない**（対象ファイルが存在しない）。
種別分類の前に「何を入力にしているか」を見る必要がある例。

#### 8-2-d. 解析の限界（AST でも見えないもの）

検出できないものを明記しておく。ここに当たる場合は人が読む。

- **`scripts/` の外への import**（`D:/tagtech/projects/` 配下など）。解決対象を
  `scripts/` 配下の `.py` に限っているため追跡が切れる
- **動的ロード**（`importlib` / `exec` / `__import__`）。原理的に静的解析では追えない
- **サブプロセス経由の I/O**（`subprocess.run(["python", "other.py"])`）。
  呼び先のファイル I/O は自分の依存だが、呼び出しは文字列なので追跡されない

#### 8-2-e. 依存は「ファイル単位」ではなく「実行されるサブコマンド単位」で見る

`task_manager.py` はファイル全体では `stream/stream_data.json`（業務状態・OBS が読む生きた状態）に
依存する。しかし cron が呼ぶのは `daily` サブコマンドだけで、`daily` は Notion を読んで
Discord に送るのみで**ファイル I/O が1件も無い**。`stream_data.json` を触るのは
`push` / `pull` サブコマンドである。

ファイル単位で判定すると「業務状態あり・後回し」と誤り、移植できるものを止めてしまう。
**AST で全体を洗ったあと、cron が実際に呼ぶ関数から辿り直す。**

#### 8-2-f. schtasks の登録が DEPRECATED なスクリプトを指していることがある

`TagTech_TaskPipeline_Daily` は `task_pipeline.py daily` を登録しているが、
`task_pipeline.py` は **2026-04-18 に DEPRECATED** となり `task_manager.py` へ統合済み。
schtask の登録が統合時に更新されていない。

**移植元は schtasks の登録先ではなく、その時点で生きている実装**。
スクリプト冒頭の `[DEPRECATED ...]` と統合先の docstring（`移行元:` 節）を必ず読む。
`task_manager.py` は `notion_sync.py` と `task_pipeline.py` の**両方**を統合しており、
対応表を1対1で考えると外す。

### 8-2-g. 移植対象から外したもの（2026-09-18 決定）

| タスク | 実体 | 除外理由 |
|---|---|---|
| `cto_notion_sync` | `stream_sync.py --loop-min 5`（OnLogon 常駐） | cron ジョブではなく**常駐ループ**。触る `stream/stream_data.json` は **OBS が読む配信用の生きた状態**で、今日も更新されている。Workers に寄せる対象ではなく、`vault-sync` と同じ**ローカル常駐の領域**。移すと配信が壊れる |
| `ciso_security_scan` | `ciso_security.py scan` | 4検査のうち①キー検査・②git 検査は **Actions（`clo_static_scan.yml` / `secret_scan.yml`）に既にある**ので廃止。③依存関係チェックのみ Actions ジョブとして新設。④ポート走査（localhost）は Actions でも Workers でも意味を持たないため廃止 |
| `chro_health_check` / `coo_ops_monitor` | `chro_hr_monitor.py` / `coo_operations.py` | 他系統に実装済み。降格のみ |
| `google_calendar_sync` | `google_calendar.py` | **定義と実装が別業務**（§8-1 手順0 の実績表を参照）。実装は AI 自動タスクの繰り返し予定を26件書き込むもので、運用ルールに反する。廃止降格 |
| `cio_daily_news` | `cio_intelligence.py daily` | **定義と実装が別業務**。収集工程が無く LLM に事実を生成させていた。出力30件中19件が出典ゼロ（§8-1-b）。再設計としてバックログへ |

### 8-2-h. 対応付けが不明なタスク（着手しない）

タスクID から実装スクリプトを機械的に特定できなかったもの。**推測で埋めない。**
対応が判明するまで移植に着手しない。

| タスク | 手がかり | 状態 |
|---|---|---|
| `cco_calendar_sync` | 稼働 schtask `CalendarPipeline` → `calendar_pipeline.py` があるが、タスクID と正規化一致せず役職・時刻も一致しない | 不明 |
| `notion_task_sync` | `task_manager.py` が `notion_sync.py` を統合しており `notify` / `sync` が候補だが、3資料のどれも裏付けない | 不明（有力候補あり） |
| `cfo_monthly_report` | `cfo_finance.py` に月次の口があるかは未確認。`AI_CFO_Finance` は日次 08:30 で時刻が合わない | 不明 |

非移植対象でも不明: `prompt_self_update_*`（3件）/ `tiktok_noon` / `tiktok_morning` /
`cpo_platform_review` / `weekly_ceo_meeting`（S3 記載のみ）。

### 8-2-h-2. Notion 疎通の既知の制約: 404 は「無い」と「共有されていない」の両方

**Notion API は「データベースが存在しない」と「Integration に共有されていない」を
どちらも HTTP 404 で返す。** レスポンス本文でも区別できない。
これは情報漏洩を防ぐための仕様で、こちらから変えられない。

したがって 404 を見たときは次の順で切り分ける。

1. **同じトークンで別の DB を読めるか試す。** 読めればトークンは有効で、
   その DB だけが共有されていない
2. DB の ID が正しいか（作成時の応答 URL と突き合わせる）
3. Notion の UI で当該 DB の `···` →「接続」を開き、
   **1 で読めた DB に付いているのと同じ名前の Integration** が入っているか見る

2026-09-18 の実例: `cto-tech-monitor` が収支台帳(DB①)に 404 を返した。
同じ `NOTION_API_KEY` で案件管理DB は読めたので、トークンではなく
DB① 側の共有漏れと確定できた。**ID の正しさだけを確認して「存在しない」と
結論づけない。**

なお売上明細(DB②)の 404 は**期待どおりの状態**である（§8-2-g の隔離）。
「404 が出た = 異常」ではなく、どの DB が 404 かで意味が逆になる。

### 8-2-h-3. Notion DB は「Integration 接続済みの親ページ配下」に作る

**Worker から読む Notion DB を新規に作るときは、必ず Integration が接続済みの
親ページの配下に作る。** ワークスペース直下に作ると Worker から HTTP 404 になる。

2026-09-18 の実例: 収支台帳をワークスペース直下（親ページ無し）に作ったところ、
`cto-tech-monitor` が 404 を返し続けた。DB 単体に Integration を接続しても解消せず、
**親ページ「💰 財務」の配下へ移動した時点で 200 になった**（移動前後の dry-run で実測）。

このワークスペースは**個別 DB ではなく親ページに Integration を接続し、
子 DB がアクセスを継承する**構成になっている。稼働中の DB はすべてこの形。

#### 親ページ構造（2026-09-18 時点）

| 親ページ | Integration | 配下の DB | Worker からの到達 |
|---|---|---|---|
| 💰 財務 | **接続済み** | 収支台帳 | ✅ 読める |
| 💼 営業・案件 | **接続済み** | 案件管理DB（CRM） / コンサル案件DB | ✅ 読める |
| （タスク管理DB は単独） | 接続済み | タスク管理 | ✅ 読める |
| **ワークスペース直下** | **未接続** | **売上明細** | ❌ 到達不可（**これが正しい状態**） |

**売上明細（購入者のハンドル名を持つ）をワークスペース直下に置いたままにするのは意図的**。
Notion API はビュー設定に関係なく全プロパティを返すので「列を隠す」では守れない。
**置き場所で分離する**（§8-2-g）。

#### 新しい DB を作るときの手順

1. 用途を決める。**Worker が読むのか、人だけが見るのか**
2. Worker が読むなら → Integration 接続済みの親ページを選び、その配下に作る
3. Worker に見せたくない情報を含むなら → **別 DB に分け、接続されていない場所に置く**
4. 作ったら `cto-tech-monitor` の dry-run で到達性を確認する。
   **応答が返ってから「接続できている」と言う**（設定画面の見た目で判断しない）

MCP の `create_database` は `parent` を省略するとワークスペース直下に作る。
**省略しないこと。** 今回の 404 はこれが原因だった。

### 8-2-i. 逐語移植したが直したい箇所（リファクタ候補）

移植は**逐語**で行うので、移植元の不具合もそのまま持ち込む。直すのは移植とは別の作業に
分け、ここに記録しておく。**運用で不便が出てから直す**（先回りで直すと、
Python 版との出力比較ができなくなり、移植が正しいことを示せなくなる）。

| 箇所 | 挙動 | 疑い | 影響 |
|---|---|---|---|
| `task_daily.ts` の `sortTasks` | **期限なしのタスクが期限ありより前に並ぶ** | Python が空文字の期限を文字列比較していたため（`"" < "2026-.."`）。意図的とは考えにくい | 日次サマリーの並び順。期限未設定のタスクが上に集まる |
| `pipeline_report.ts` | stalled 判定の条件が重複 / 未使用の `stage_counts` | 移植時に冒頭コメントへ記録済み | 出力に影響なし |

### 8-3. 監視機能を足したときの数値の読み方

notify-gw に監視ジョブ（PAT 期限監視・バインディング死活監視・モデル deprecation 監視など）を
足すと、それ自体が `events` に証跡を出すため **`autonomy_v1` の subject として現れ、
notify-gw 自身の自律度スコアが上がる**。測定器が測定対象に入る形になる。

これは不正ではない（実際に動いているジョブなので測られるのが正しい）。ただし
**監視機能の追加による上昇は業務の改善ではない。** 数値が上がったときは
`notify-gw/` 接頭辞の subject が増えていないかを先に確認する（接頭辞で判別できるので
追加の仕組みは要らない）。

監視の情報源は **機械可読なもの（API・モデル一覧エンドポイント・RSS）に限定**し、
`expect=external_data` を宣言する。**LLM に聞いてはいけない**
（`hn_trends_morning` が「HN の記事一覧」ではなく「bot の作り方」を返したのと同じ穴になる）。

### 8-4. 廃止の判断は「動かした後」に行う

一度も稼働した実績がないものは「不要」ではなく **「価値が未知」**。動かして出力を見るまで
廃止判断をしない。例外は測定対象が定義できないもの（`chro_mood_monitor` は
「AIエージェントのムード」に測定対象がなく、LLM に聞けば作り話にしかならないため
動かす前に廃止と判断した）。

### 8-5. Worker の本番デプロイ元は `main` だけ（2026-09-21 社長判断）

**`wrangler deploy` は tagtech の `main` からのみ実行する。** 長命ブランチ
（`chore/claude-devops-setup` 等）で行った Worker の変更は、**main にマージしてからデプロイ**する。
ブランチから直接デプロイしない。

理由（2026-09-20 に実際に起きたこと）: tagtech-cron を main と `chore/claude-devops-setup` の
両方から手元デプロイした結果、互いの変更を本番から消し合った。main からのデプロイ
（PR #69・funding-reminder 除去）で chore 側にしか無かったバインディング自己申告が消え、
逆方向では main 側の cto-tech-monitor / task-pipeline が一度消えた。復元は PR #67 の
cherry-pick（tagtech `9db40db`）と 2026-09-20T20:45Z の再デプロイで行った。
これは §5 の「起点ずれ」と同じ構造（長命ブランチが main と乖離する）が本番デプロイに
波及したものである。詳細な時系列と「列挙されたら1本化する」読み方は §8-1-b-2 実例2。

デプロイ前の確認は tagtech `cloudflare/tagtech-cron/scripts/predeploy_check.mjs`
（検査3が `origin/main` にマージ済みであることを要求する）を通す。
同じ規律は tagtech-cron 以外の Worker（vault-intel・growth-collector）にも適用する。
2026-09-21 時点で `cloudflare/vault-intel/` は main に存在せず chore 側にしか無い
（本番は 2026-09-13 にそこからデプロイされている）ため、main への取り込みが先。

デプロイ後は `binding_reports.reported_at`（§2-1・§3）が更新されることを確認する。
止まっていれば 26 時間後に「死亡疑い」の警報になる。

## 9. `gh` コマンドの事故防止

2026-09-15、`gh pr merge` の使い方で**2件の事故**が起きた。どちらも「コマンドは成功したが、
意図しない対象に作用した」型で、出力を見ただけでは気づけない。

### 9-1. PR 操作は必ず `-R` でリポジトリを明示する

```
✅ gh pr merge 11 -R nikkun22/tagtech-automation --rebase
✅ gh pr view 11 -R nikkun22/tagtech-automation --json state,mergedAt
❌ cd D:/tagtech/projects/tagtech-automation && gh pr merge 11 --rebase
```

`gh` は**カレントディレクトリの git remote からリポジトリを推測する**。
`cd` 先を間違えると別リポジトリを操作する。

**PR 番号はリポジトリごとに独立している**ので、番号を指定すれば
たいてい「別リポジトリの何か」にヒットしてしまう。エラーにならないのが厄介なところ。

実害: `D:/tagtech/cloudflare/tagtech-automation`（存在しないパス）へ `cd` したつもりで
`D:/tagtech` のまま `gh pr merge 11` を実行し、**別リポジトリ `nikkun22/tagtech` の
PR #11（2026-05-09 にマージ済み）を操作**して、そのリモートブランチを削除した。

**`cd` に依存する手順を書かない。** 手順を人に渡すときも必ず `-R` を付けた形にする。

### 9-2. 「Delete the branch locally?」には常に `No`

**既にマージ済みの PR に `gh pr merge` を再実行すると、マージは行われず
このプロンプトだけが出る。** マージ操作のつもりで進めると、ブランチ削除だけが実行される。

実害: マージ済みの PR に対して2回目の `gh pr merge` を実行し、`Yes` を選んだため
リモートブランチが削除された（内容は master に保全されていたため実害なし）。

### 9-3. マージ済みかは先に確認する。`gh pr merge` を再実行しない

```
gh pr view <番号> -R nikkun22/<repo> --json state,mergedAt
```

`state=MERGED` かつ `mergedAt` に日時が入っていればマージ済み。
**「マージしたつもり」と実際の状態は食い違う。** 2026-09-15 には
この食い違いが3回起きた（PR #55 で2回、#56 で1回）。

`--delete-branch` は**常に付けない**（worktree ごと消える事故が 2026-09-13 に発生）。
ブランチを消すときは `git worktree remove` と `git push origin --delete` で明示的に行う。

### 9-4. 削除した worktree の記録

| 日付 | worktree | ブランチ | 削除前の確認 |
|---|---|---|---|
| 2026-09-15 | `D:/tagtech/projects/tagtech-automation-demote` | `chore/demote-pipeline` | 未コミット0件・内容は `origin/master` と差分0・他セッション未使用 |
| 2026-09-15 | `D:/tagtech/projects/tagtech-automation-expect` | `feat/expect-deterministic` | 未コミット0件・ブランチ固有の差分は「降格前の古い状態」のみで失われる成果なし・他セッション未使用 |
| 2026-09-21 | `D:/tagtech-seed-main`・`D:/tagtech-skills-main-landing`・`D:/tagtech-skills-rename`・`D:/tagtech-task-actions-node24`・`D:/tagtech-task-clo-scan-revert`・`D:/tagtech-task-wsl-guard`・`D:/tagtech/projects/tagtech-automation-notify-gw`・`D:/tagtech/projects/notify-gw-model-watch` | 各種 | 全件マージ済み(`gh pr view --json state,mergedAt`)・未コミット0件を個別確認 |
| 2026-09-21 | `D:/tagtech-seed-base`・`D:/tagtech/projects/tagtech-automation-seed` | detached HEAD(一時 exporter 実行用) | 未コミット0件・役目終了(seed 生成完了) |
| 2026-09-21 | `D:/tagtech-task-dedupe-cron` | `deploy/tagtech-cron-20260921` | 未コミット0件・役目は `D:/tagtech-cron-port` へ移行済み |
| 2026-09-21 | `D:/tagtech/projects/tagtech-automation-cicd`・`D:/tagtech/projects/tagtech-automation-cron` | `bot/work-cicd`・`bot/work-cron` | 未追跡 `AGENTS.md`/`CLAUDE.md`/`CODEX_CLAUDE.md` を `tagtech-automation-guard/_evidence/worktree_<name>_untracked_20260921/` へ保存してから `--force` 削除(`master` より古い `bot/*` ブランチの worktree で、**ここから deploy すると master の設定を巻き戻す**と以前から記録されていた。§8-5 と同型の事故源) |
| 2026-09-21 | `D:/tagtech-task-chro-failsafe-deps` | `task/chro-failsafe-deps` | branch tip が `origin/main` の祖先であることを `merge-base --is-ancestor` で確認(完全マージ済み)・未コミット2件は `STATUS.md`/`scheduled_tasks.json` の自動同期ノイズのみ |

**`--rebase` マージ後は SHA が一致しない**ので、`git merge-base --is-ancestor` では
「master に含まれない」と出る。**保全の判定は SHA ではなく内容**で行う
（`git diff <branch> origin/master` が空か、差分が「古い状態」だけか）。

### 9-5. 主 checkout の一覧（worktree を消す前に必ず確認する）

**`git worktree remove` は対象が主リポジトリ（bare の実体がある場所）だと `fatal: is a main working tree` で拒否される。** これは安全装置だが、逆に言えば「どれが主か」を事前に知らずに一覧から機械的に判断すると、拒否されるまで気づけない。2026-09-21、`tagtech-automation` を worktree 一覧の見た目だけで「削除候補」に分類しかけたが、実際には**その3リポジトリの主 checkout だった**（`tagtech-automation-guard` は `master` ブランチの linked worktree の一つに過ぎない）。

| リポジトリ | 主 checkout（`.git` が実体） | 備考 |
|---|---|---|
| `nikkun22/tagtech` | `D:/tagtech` | `chore/claude-devops-setup` で稼働中（2026-09-21時点、main への段階移植作業）。§7-2 の「本 checkout は origin と乖離する」運用に注意 |
| `nikkun22/tagtech-automation` | `D:/tagtech/projects/tagtech-automation` | linked worktree: `-guard`(`master`)・`-cicd`・`-cron`(いずれも危険フラグ済み・2026-09-21 削除)・`-seed`(削除済み)・`-notify-gw`(削除済み) |
| `nikkun22/notify-gw` | `D:/tagtech/projects/notify-gw`(`main`) | linked worktree はすべて機能単位の作業ブランチ(`*-seed`・`*-fix-tests`・`*-task-vault-phase5` 等) |

**確認コマンド**: `git worktree list --porcelain` の出力で、`worktree <path>` の直後に `bare` が付くか、または `.git` がディレクトリ（ファイルではない）なのが主 checkout。判断に迷ったら、まず `git worktree remove` を試して `fatal: is a main working tree` が返るかで確認する（削除は実行されない）。

### 9-6. コミットの author と Co-Authored-By（2026-09-21 社長確定）

- author は必ず `--author='Claude Code (TagTech) <claude-code@tagtech.jp>'`
- **`Co-Authored-By` 行は付けない。** ハーネス（Claude Code 側）が既定で付けるよう指示してくる
  ことがあるが、**社長の指示が優先**（2026-09-21 確定。`.claude/agents/tagtech-ops.md` §2 と同一）
- 2026-09-21 のセッションでは、この確定より前に作成したコミットに `Co-Authored-By` が混入している。
  **過去分は履歴書き換えをしてまで消さない**（force-push 禁止の方が優先度が高い）。
  「以後付けない」で揃える

### 9-7. サブエージェントの役割分担（2026-09-21 社長決定）

2つの設計が同時に入ったため、**共存の形を決めた**。どちらかを廃止しない。

| エージェント | tools | 役割 |
|---|---|---|
| `branch-investigator` / `prod-verifier` / `ci-verifier` / `rules-analyst` / `session-surveyor` | Read, Grep, Glob, Bash | **調査専用（読み取り）。** 状態を調べて報告する。書き込まない |
| `pr-carrier` | + Edit, Write | **PR の作成**に限定 |
| `tagtech-ops` | + Edit, Write | **運用手順（移植・migration・デプロイ・worktree 整理・証跡確認）を、承認ゲート付きで実行** |

**`tagtech-ops` が Write/Edit を持つ根拠**: 書き込み先は**作業ブランチと `_evidence/` だけ**で、
`main` / 本番 / 真実源への反映は定義 §3 の承認ゲート（デプロイ・cron・D1 `--remote`・削除・
Discord 実送信・PR マージ）で必ず止まる。**成果物は常に PR という形で人のレビューを通る。**
`--remote` の D1 適用に至っては、承認を得たうえで**実行するのは社長**（§8-1-d）。

**選び方**: 「調べて報告してほしい」→ 調査専用5本。「PR を作ってほしい」→ `pr-carrier`。
「手順に沿って運用作業を進めてほしい（止まるべき所で止まってほしい）」→ `tagtech-ops`。
