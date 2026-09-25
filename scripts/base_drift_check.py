#!/usr/bin/env python3
"""起点ずれ検出 — ブランチの起点が main から古くなっていないかを検査する。

GitHub Free では private リポジトリで branch protection が使えず、
「Require branches to be up to date before merging」を設定できない(2026-09-15 実測)。
この検査はその代替として、PR 画面に赤として可視化する。

判定は merge-base を使った2区分で行う。削除行数の閾値は持たない。

    起点ずれ(未取り込み)
        main にあってブランチに無く、かつ merge-base にも無いファイル。
        分岐後に main 側で追加されたもので、ブランチはその存在を知らない。
        「知らないファイルを意図的に消す」ことはできないので、これは
        ブランチの意思ではなく、起点が古いことの機械的な証拠になる。

        さらにパスで2つに分ける(BLOCKING_PREFIXES 参照):
          要対処 … migrations/ data/ scripts/ tests/ .github/workflows/
                   生成物の作り直しや未検証のテスト通過という実害に直結する
                   -> 失敗 (exit 1)
          注記   … 上記以外(docs/ 等)。起点は古いが実害が無い
                   -> 成功 (exit 0)。警告として表示するだけ

    ブランチによる削除 / 移動
        main にあってブランチに無く、merge-base には有ったファイル。
        ブランチが意図して消した(または別のパスへ移した)もの。
        -> 警告のみ。絶対に失敗させない (正当な削除で赤くすると赤が無視される)

■ この検査が「防ぐもの」と「防がないもの」(2026-09-15 実測で確認)

防がない: マージによるファイル消失。**これは起きない。** merge commit /
    git merge --squash / PR の三点差分の適用、いずれの方式でも main 側の
    ファイルは保たれることを対照実験で確認した。main の直近25コミットでも、
    マージでファイルが消えた事実は0件だった。
    `git diff --stat origin/main..<branch>` の「削除行」は、**起点が古いことの
    指標であって、マージで消えることの指標ではない。** ここを取り違えて
    「消失事故」と記録した前例があるので、繰り返さないこと。

防ぐ: 古い起点のまま作業を進めること自体。具体的には
    - 生成物をこのブランチで作り直すと、main の新しい内容を含まない版が入る
      (自律度計測の seed 再生成がこの構造)
    - main が追加したテスト・制約をブランチの変更が満たすか未検証のまま通る
      (マージは綺麗に通るのに main の CI が壊れる、いわゆる意味的衝突)

検出できるのはファイル単位の差だけである。main 側の行単位の変更をブランチが
知らないケースは検出できない。参考値として behind コミット数を併記するが、
behind > 0 だけでは失敗させない。

日付・時刻・タイムゾーンを一切参照しない。時刻依存のテストで「毎日9時間だけ赤い」
CI を作った前例(2026-09-14)があるため、この検査は git の到達可能性とツリーの
内容だけで判定する。

使い方:
    # マージ前のローカル確認
    python scripts/base_drift_check.py

    # 任意のブランチを検査
    python scripts/base_drift_check.py --head origin/feat/xxx

    # 判定ロジック自身の自己検証(CI の第1ステップ)
    python scripts/base_drift_check.py --self-test

終了コード:
    0 = 問題なし(真の削除のみの場合も 0)
    1 = 起点ずれを検出
    2 = 検査自体が成立しなかった(ref が無い・merge-base が無い・git が失敗)
        沈黙して 0 を返してはいけない。「見ていないのに緑」が最も害になる。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile

# 一覧に出す最大件数。306 ファイル消失する実例(tagtech PR #31)があるため上限を設ける。
MAX_LIST = 20

# 未取り込みを「赤(exit 1)」にするか「注記のみ(exit 0)」にするかをパスで分ける。
# ここを変更するときは、下の改訂メモに日付と理由を必ず追記すること。
BLOCKING_PREFIXES = (
    "migrations/",         # 生成物を古い状態から作り直す事故に直結する
    "data/",               # 分類表など、生成物の入力
    "scripts/",            # 生成スクリプト本体
    "tests/",              # main が追加したテストを未検証のまま通す
    ".github/workflows/",  # main が追加した CI を通さずにマージする
)
# 上記以外(docs/ や *.md 等)は実害が無いので注記に留める。
#
# 改訂メモ:
#   2026-09-18 制定。導入当初は未取り込みが 1 件でもあれば赤にしていたが、
#   この検査自身を main に入れた PR #57 のマージが docs を 1 ファイル
#   (docs/ops/base_drift_check_20260915.md) 追加した時点で、open PR 9 本が
#   すべて赤になった。実害の無い追加で全部が赤くなる状態は初日から無視される。
#   「常に緑のチェック」の裏返しなので、実害に立ち返ってパスで分けた。

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_ERROR = 2


class GitError(RuntimeError):
    """git コマンドが失敗した、または検査が成立しなかった。"""


def git(repo: str, *args: str) -> str:
    """git を実行して stdout を返す。失敗したら GitError。

    パスに日本語・空白が含まれても壊れないよう、呼び出し側は -z 系を使う。
    surrogateescape にしているのは UTF-8 でないパスが来ても例外にしないため。
    """
    proc = subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="surrogateescape",
    )
    if proc.returncode != 0:
        raise GitError(
            "git {} が失敗しました (exit {}): {}".format(
                " ".join(args), proc.returncode, (proc.stderr or "").strip()
            )
        )
    return proc.stdout


def nul_list(raw: str) -> list[str]:
    """-z 出力(NUL 区切り)を配列にする。"""
    return [item for item in raw.split("\0") if item]


def resolve_commit(repo: str, rev: str) -> str:
    try:
        return git(repo, "rev-parse", "--verify", "--quiet", rev + "^{commit}").strip()
    except GitError:
        raise GitError(
            "ref '{}' を解決できません。fetch が足りているか確認してください"
            "(CI では actions/checkout に fetch-depth: 0 が必要)".format(rev)
        )


def count_commits(repo: str, range_expr: str) -> int:
    return int(git(repo, "rev-list", "--count", range_expr).strip() or "0")


def classify(repo: str, base: str, head: str) -> dict:
    """base にあって head に無いファイルを、merge-base の有無で2区分に分ける。"""
    base_sha = resolve_commit(repo, base)
    head_sha = resolve_commit(repo, head)

    try:
        merge_base = git(repo, "merge-base", base_sha, head_sha).strip()
    except GitError:
        raise GitError(
            "merge-base がありません。'{}' と '{}' は履歴を共有していません"
            "(浅いクローンか、無関係なリポジトリの可能性)".format(base, head)
        )
    if not merge_base:
        raise GitError("merge-base が空でした: {} と {}".format(base, head))

    # base..head の二点比較。base にあって head に無いものが D として出る。
    #
    # --no-renames は必須。git の既定は rename 検出が有効で、main が追加した
    # ファイルと、ブランチ側にある内容の似た別ファイルが「移動」として対になると、
    # 消失が D に出ずに見逃される。検出漏れ(静かに緑)は誤検出より害が大きいので、
    # rename 検出を切って素の追加・削除として扱う。
    # 副作用として _moved_ への退避が D + A に分解されるが、退避元は merge-base に
    # 存在するため「真の削除」に分類され、警告のみで失敗にはならない。
    missing = nul_list(
        git(repo, "diff", "--diff-filter=D", "--name-only", "-z", "--no-renames",
            "{}..{}".format(base_sha, head_sha))
    )

    # merge-base のツリーを1回だけ取って集合化する。
    # ファイルごとに cat-file -e を呼ぶと 306 件で 306 プロセスになるため。
    at_merge_base = set(nul_list(git(repo, "ls-tree", "-r", "--name-only", "-z", merge_base)))

    drift = [f for f in missing if f not in at_merge_base]
    genuine = [f for f in missing if f in at_merge_base]

    # 未取り込みを実害の有無で分ける。赤にするのは blocking だけ。
    # advisory も「起点が古い」ことに変わりはないので注記としては出す。
    blocking = [f for f in drift if f.startswith(BLOCKING_PREFIXES)]
    advisory = [f for f in drift if not f.startswith(BLOCKING_PREFIXES)]

    # 警告側(判定に影響しない方)だけは rename 検出を有効にした結果と突き合わせて、
    # 「移動しただけ」と「本当に消した」を分けて表示する。
    # 判定(drift)は上の --no-renames の結果のみを使う。rename 検出は消失を隠しうるので、
    # 失敗判定には絶対に使わない。
    paired_off = set(nul_list(
        git(repo, "diff", "--diff-filter=D", "--name-only", "-z",
            "{}..{}".format(base_sha, head_sha))
    ))
    moved = [f for f in genuine if f not in paired_off]
    deleted = [f for f in genuine if f in paired_off]

    return {
        "base": base,
        "head": head,
        "base_sha": base_sha,
        "head_sha": head_sha,
        "merge_base": merge_base,
        "behind": count_commits(repo, "{}..{}".format(head_sha, base_sha)),
        "ahead": count_commits(repo, "{}..{}".format(base_sha, head_sha)),
        "drift": drift,
        "blocking": blocking,
        "advisory": advisory,
        "genuine": genuine,
        "moved": moved,
        "deleted": deleted,
    }


def format_list(files: list[str]) -> list[str]:
    lines = ["    - {}".format(f) for f in files[:MAX_LIST]]
    if len(files) > MAX_LIST:
        lines.append("    - ...ほか {} 件".format(len(files) - MAX_LIST))
    return lines


def write_step_summary(result: dict, failed: bool, allowed: bool) -> None:
    """GitHub Actions のステップサマリに表を書く。CI 以外では何もしない。"""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    verdict = "🟢 実害のあるパスの未取り込みなし"
    if failed:
        verdict = "🔴 起点が古い（実害のあるパス）"
    elif result["blocking"]:
        verdict = "🟡 起点が古い（ラベルで許可済み）"
    elif result["advisory"]:
        verdict = "🟢 起点は古いが実害のあるパスではない"

    rows = [
        "## 起点ずれ検出: {}".format(verdict),
        "",
        "| 項目 | 値 |",
        "|---|---|",
        "| 比較元 (base) | `{}` = `{}` |".format(result["base"], result["base_sha"][:12]),
        "| 比較先 (head) | `{}` = `{}` |".format(result["head"], result["head_sha"][:12]),
        "| 分岐点 (merge-base) | `{}` |".format(result["merge_base"][:12]),
        "| base に遅れているコミット数 | {} |".format(result["behind"]),
        "| base より進んでいるコミット数 | {} |".format(result["ahead"]),
        "| **起点ずれ・要対処（実害のあるパス）** | **{} ファイル** |".format(
            len(result["blocking"])),
        "| 起点ずれ・注記のみ（それ以外のパス） | {} ファイル |".format(
            len(result["advisory"])),
        "| ブランチが削除（警告のみ） | {} ファイル |".format(len(result["deleted"])),
        "| 移動（警告のみ） | {} ファイル |".format(len(result["moved"])),
        "",
        "判定に使うのは「要対処」だけです。対象パス: {}".format(
            " / ".join("`{}`".format(p) for p in BLOCKING_PREFIXES)),
        "",
    ]
    if result["advisory"]:
        rows += [
            "### 起点ずれ・注記のみ（判定には影響しません）",
            "",
        ] + ["- `{}`".format(f) for f in result["advisory"][:MAX_LIST]]
        if len(result["advisory"]) > MAX_LIST:
            rows.append("- ...ほか {} 件".format(len(result["advisory"]) - MAX_LIST))
        rows.append("")
    if result["blocking"]:
        rows += [
            "### 起点ずれ・要対処（main が追加し、このブランチが知らないファイル）",
            "",
        ] + ["- `{}`".format(f) for f in result["blocking"][:MAX_LIST]]
        if len(result["blocking"]) > MAX_LIST:
            rows.append("- ...ほか {} 件".format(len(result["blocking"]) - MAX_LIST))
        rows += [
            "",
            "**マージでこれらが失われることはありません。** 問題は、このブランチの作業が "
            "main の現在の状態を反映していないことです"
            "（生成物を古い状態から作り直す／main が追加したテストを未検証のまま通す）。",
            "",
            "**修正**: `git fetch origin && git merge origin/main`"
            "（または `git rebase origin/main`）",
            "",
            "意図的に古い起点のまま残す場合は、PR にラベル **起点ずれ承知** を付けてください。",
            "",
        ]
    if result["deleted"]:
        rows += ["### ブランチが削除（判定には影響しません）", ""]
        rows += ["- `{}`".format(f) for f in result["deleted"][:MAX_LIST]]
        if len(result["deleted"]) > MAX_LIST:
            rows.append("- ...ほか {} 件".format(len(result["deleted"]) - MAX_LIST))
        rows.append("")
    if result["moved"]:
        rows += [
            "### 移動（別のパスへ移動。内容は失われていません）",
            "",
            "{} ファイル".format(len(result["moved"])),
            "",
        ]

    with open(path, "a", encoding="utf-8") as fh:
        fh.write("\n".join(rows) + "\n")


def report(result: dict, allow_drift: bool) -> int:
    drift = result["drift"]
    blocking = result["blocking"]
    advisory = result["advisory"]
    genuine = result["genuine"]
    # 赤にするのは実害のあるパス(blocking)だけ。advisory は注記に留める。
    failed = bool(blocking) and not allow_drift

    print("比較: {} ({}) .. {} ({})".format(
        result["base"], result["base_sha"][:12], result["head"], result["head_sha"][:12]))
    print("分岐点: {}  / base に {} コミット遅れ・base より {} コミット進み".format(
        result["merge_base"][:12], result["behind"], result["ahead"]))
    print("main にあってブランチに無いファイル: 計 {} 件"
          "（起点ずれ（未取り込み） {} 件 = 要対処 {} 件 / 注記 {} 件"
          " ／ ブランチが削除 {} 件 / 移動 {} 件）".format(
              len(drift) + len(genuine), len(drift), len(blocking), len(advisory),
              len(result["deleted"]), len(result["moved"])))

    if result["deleted"]:
        print("")
        print("[情報] ブランチが削除（merge-base に存在したものを意図的に消した）:")
        for line in format_list(result["deleted"]):
            print(line)
        print("    これは意図的な削除として扱い、判定には影響させません。")
        if os.environ.get("GITHUB_ACTIONS"):
            print("::warning::真の削除 {} 件（判定には影響しません）".format(len(result["deleted"])))

    if result["moved"]:
        print("")
        print("[情報] 移動（別のパスへ移された。内容は失われていない）: {} 件".format(
            len(result["moved"])))
        for line in format_list(result["moved"]):
            print(line)

    if advisory:
        print("")
        print("[情報] 起点は古いが、実害のあるパスではない未取り込み: {} 件".format(
            len(advisory)))
        for line in format_list(advisory):
            print(line)
        print("    これらは {} なので、判定には影響させません。".format(
            " / ".join(BLOCKING_PREFIXES) + " のいずれにも属さないパス"))
        print("    取り込みたい場合は git merge origin/main。")
        if os.environ.get("GITHUB_ACTIONS"):
            print("::warning::起点が古いままですが、実害のあるパスではありません"
                  "（未取り込み {} 件・判定には影響しません）。".format(len(advisory)))

    if blocking:
        print("")
        print("[NG] 起点が古いままです。"
              "このブランチは {} が持つ {} ファイルを知りません"
              "（うち実害のあるパス {} 件）。".format(
                  result["base"], len(drift), len(blocking)))
        for line in format_list(blocking):
            print(line)
        print("")
        print("    これらは分岐後に {} 側で追加されたファイルです。".format(result["base"]))
        print("    マージでこれらが失われることはありません（git が正しく扱います）。")
        print("    問題は、このブランチの作業が {} の現在の状態を反映していないことです:".format(
            result["base"]))
        print("      - 生成物をこのブランチで作り直すと、"
              "main の新しい内容を含まない版が入る")
        print("      - main が追加したテスト・制約を満たすか未検証のまま通る")
        print("        （マージは通るのに main の CI が壊れる）")
        print("")
        print("    修正: git fetch origin && git merge origin/main")
        print("          （または git rebase origin/main）")
        print("")
        print("    意図的に古い起点のまま残す場合は、"
              "PR にラベル「起点ずれ承知」を付けてください。")
        if os.environ.get("GITHUB_ACTIONS"):
            for f in blocking[:MAX_LIST]:
                print("::error::main にあってこのブランチに無い: {}".format(f))
            print("::error::起点が古いままです（実害のあるパスの未取り込み {} 件）。"
                  "git merge origin/main で解消してください。".format(len(blocking)))
    else:
        print("")
        print("[OK] 実害のあるパスの未取り込みはありません。")

    if blocking and allow_drift:
        print("")
        print("[許可] ラベル「起点ずれ承知」が付いているため、"
              "起点ずれ {} 件を許可して成功扱いにします。".format(len(blocking)))
        if os.environ.get("GITHUB_ACTIONS"):
            print("::warning::起点ずれ {} 件をラベルで許可しました。".format(len(blocking)))

    write_step_summary(result, failed, allow_drift)
    return EXIT_DRIFT if failed else EXIT_OK


def run_check(repo: str, base: str, head: str, allow_drift: bool) -> int:
    """判定して結果を出力し、終了コードを返す。self-test もこの関数を通す。"""
    try:
        result = classify(repo, base, head)
    except GitError as exc:
        print("[エラー] 検査が成立しませんでした: {}".format(exc), file=sys.stderr)
        if os.environ.get("GITHUB_ACTIONS"):
            print("::error::起点ずれ検出が成立しませんでした: {}".format(exc))
        return EXIT_ERROR
    return report(result, allow_drift)


# ---------------------------------------------------------------------------
# 自己検証
# ---------------------------------------------------------------------------
# 「常に緑のチェック」を構造的に作れないようにするための自己検証。
# 使い捨ての git リポジトリを一時ディレクトリに作って判定を実際に走らせる。
# リポジトリ内のファイルには一切触らない。
#
# commit.gpgsign=false を付けているのは、この使い捨てリポジトリでの commit が
# 社長のグローバル設定(署名)に左右されないようにするため。本物のコミットの
# 署名方針を変えるものではない。

SANDBOX_GIT_CONF = [
    "-c", "user.name=selftest",
    "-c", "user.email=selftest@example.invalid",
    "-c", "commit.gpgsign=false",
]


def _sbx(repo: str, *args: str) -> str:
    return git(repo, *SANDBOX_GIT_CONF, *args)


def _write(repo: str, rel: str, text: str) -> None:
    path = os.path.join(repo, rel)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def _add(repo: str, *paths: str) -> None:
    # pathspec を必ず明示する(git add -A / git add . は使わない)。
    _sbx(repo, "add", "--", *paths)


def _rm(repo: str, path: str) -> None:
    _sbx(repo, "rm", "-q", "--", path)


def _commit(repo: str, message: str) -> None:
    _sbx(repo, "commit", "-q", "-m", message)


def _new_repo(tmp: str, name: str) -> str:
    repo = os.path.join(tmp, name)
    os.makedirs(repo)
    git(repo, "init", "-q", "-b", "main")
    _write(repo, "a.txt", "a\n")
    _write(repo, "keep.txt", "keep\n")
    _add(repo, "a.txt", "keep.txt")
    _commit(repo, "init")
    return repo


def _scenario_drift(tmp: str) -> str:
    """main が分岐後に migrations/ へ追加。feature はそれを知らない。

    追加先を BLOCKING_PREFIXES 配下にしているのは意図的。ここをルート直下の
    new.txt にすると注記扱いになり、このケースは赤にならない。
    """
    repo = _new_repo(tmp, "drift")
    _sbx(repo, "checkout", "-q", "-b", "feature")
    _write(repo, "f.txt", "f\n")
    _add(repo, "f.txt")
    _commit(repo, "feature の作業")
    _sbx(repo, "checkout", "-q", "main")
    _write(repo, "migrations/0001_new.sql", "-- new\n")
    _add(repo, "migrations/0001_new.sql")
    _commit(repo, "main に migrations を追加")
    return repo


def _scenario_advisory_only(tmp: str) -> str:
    """main が分岐後に docs/ だけを追加。実害が無いので赤にしない。"""
    repo = _new_repo(tmp, "advisory")
    _sbx(repo, "checkout", "-q", "-b", "feature")
    _write(repo, "f.txt", "f\n")
    _add(repo, "f.txt")
    _commit(repo, "feature の作業")
    _sbx(repo, "checkout", "-q", "main")
    _write(repo, "docs/ops/note.md", "# note\n")
    _add(repo, "docs/ops/note.md")
    _commit(repo, "main に docs を追加")
    return repo


def _scenario_blocking_and_advisory(tmp: str) -> str:
    """main が migrations/ と docs/ の両方を追加。migrations があるので赤。"""
    repo = _new_repo(tmp, "mixedpath")
    _sbx(repo, "checkout", "-q", "-b", "feature")
    _write(repo, "f.txt", "f\n")
    _add(repo, "f.txt")
    _commit(repo, "feature の作業")
    _sbx(repo, "checkout", "-q", "main")
    _write(repo, "migrations/0001_new.sql", "-- new\n")
    _write(repo, "docs/ops/note.md", "# note\n")
    _add(repo, "migrations/0001_new.sql", "docs/ops/note.md")
    _commit(repo, "main に migrations と docs を追加")
    return repo


def _scenario_genuine(tmp: str) -> str:
    """feature が merge-base に存在した a.txt を消した。正当な削除。"""
    repo = _new_repo(tmp, "genuine")
    _sbx(repo, "checkout", "-q", "-b", "feature")
    _rm(repo, "a.txt")
    _commit(repo, "a.txt を削除")
    return repo


def _scenario_relocated(tmp: str) -> str:
    """feature が a.txt を _moved_20260915/ へ退避した。"""
    repo = _new_repo(tmp, "relocated")
    _sbx(repo, "checkout", "-q", "-b", "feature")
    os.makedirs(os.path.join(repo, "_moved_20260915"))
    shutil.move(os.path.join(repo, "a.txt"),
                os.path.join(repo, "_moved_20260915", "a.txt"))
    _sbx(repo, "add", "--", "a.txt", "_moved_20260915/a.txt")
    _commit(repo, "a.txt を _moved_ へ退避")
    return repo


def _scenario_up_to_date(tmp: str) -> str:
    """feature が main を取り込み済み。起点ずれは解消されている。"""
    repo = _scenario_drift(tmp)
    _sbx(repo, "checkout", "-q", "feature")
    _sbx(repo, "merge", "-q", "--no-edit", "main")
    return repo


def _scenario_identical(tmp: str) -> str:
    """feature が main と同一。"""
    repo = _new_repo(tmp, "identical")
    _sbx(repo, "checkout", "-q", "-b", "feature")
    return repo


def _scenario_mixed(tmp: str) -> str:
    """起点ずれ 1 件と真の削除 1 件が混在。"""
    repo = _new_repo(tmp, "mixed")
    _sbx(repo, "checkout", "-q", "-b", "feature")
    _rm(repo, "a.txt")
    _commit(repo, "a.txt を削除")
    _sbx(repo, "checkout", "-q", "main")
    _write(repo, "migrations/0001_new.sql", "-- new\n")
    _add(repo, "migrations/0001_new.sql")
    _commit(repo, "main に migrations を追加")
    return repo


def _scenario_unrelated(tmp: str) -> str:
    """履歴を共有しない2つのルート。merge-base が取れない。"""
    repo = _new_repo(tmp, "unrelated")
    _sbx(repo, "checkout", "-q", "--orphan", "feature")
    _sbx(repo, "rm", "-rq", "--cached", "--", ".")
    for leftover in ("a.txt", "keep.txt"):
        path = os.path.join(repo, leftover)
        if os.path.exists(path):
            os.remove(path)
    _write(repo, "other.txt", "other\n")
    _add(repo, "other.txt")
    _commit(repo, "無関係なルート")
    return repo


def self_test() -> int:
    """11 ケースを実際の git リポジトリで検証する。1つでも外れたら失敗。"""
    cases = [
        # (名前, シナリオ, base, head, allow_drift,
        #  期待コード, 期待drift, 期待blocking, 期待advisory, 期待deleted, 期待moved)
        ("起点ずれのみ（migrations）", _scenario_drift, "main", "feature", False,
         EXIT_DRIFT, 1, 1, 0, 0, 0),
        ("起点ずれ + ラベル許可", _scenario_drift, "main", "feature", True,
         EXIT_OK, 1, 1, 0, 0, 0),
        ("docs のみ未取り込み → 緑（注記）", _scenario_advisory_only, "main", "feature", False,
         EXIT_OK, 1, 0, 1, 0, 0),
        ("migrations を含む → 赤", _scenario_blocking_and_advisory, "main", "feature", False,
         EXIT_DRIFT, 2, 1, 1, 0, 0),
        ("真の削除のみ", _scenario_genuine, "main", "feature", False,
         EXIT_OK, 0, 0, 0, 1, 0),
        ("_moved_ への退避は移動として扱う", _scenario_relocated, "main", "feature", False,
         EXIT_OK, 0, 0, 0, 0, 1),
        ("main 取り込み済み", _scenario_up_to_date, "main", "feature", False,
         EXIT_OK, 0, 0, 0, 0, 0),
        ("main と同一", _scenario_identical, "main", "feature", False,
         EXIT_OK, 0, 0, 0, 0, 0),
        ("起点ずれと削除の混在", _scenario_mixed, "main", "feature", False,
         EXIT_DRIFT, 1, 1, 0, 1, 0),
        ("存在しない base", _scenario_drift, "no-such-ref", "feature", False,
         EXIT_ERROR, None, None, None, None, None),
        ("履歴が無関係", _scenario_unrelated, "main", "feature", False,
         EXIT_ERROR, None, None, None, None, None),
    ]

    failures = []
    with tempfile.TemporaryDirectory(prefix="base-drift-selftest-") as tmp:
        for idx, (name, build, base, head, allow, want_code, want_drift,
                  want_blocking, want_advisory, want_deleted, want_moved) in enumerate(cases):
            work = os.path.join(tmp, "case{}".format(idx))
            os.makedirs(work)
            repo = build(work)

            got_code = run_check(repo, base, head, allow)
            problems = []
            if got_code != want_code:
                problems.append("exit={} 期待={}".format(got_code, want_code))
            if want_drift is not None:
                try:
                    res = classify(repo, base, head)
                    if len(res["drift"]) != want_drift:
                        problems.append("起点ずれ={} 期待={}".format(len(res["drift"]), want_drift))
                    if len(res["blocking"]) != want_blocking:
                        problems.append("要対処={} 期待={}".format(len(res["blocking"]), want_blocking))
                    if len(res["advisory"]) != want_advisory:
                        problems.append("注記={} 期待={}".format(len(res["advisory"]), want_advisory))
                    if len(res["deleted"]) != want_deleted:
                        problems.append("真の削除={} 期待={}".format(len(res["deleted"]), want_deleted))
                    if len(res["moved"]) != want_moved:
                        problems.append("移動={} 期待={}".format(len(res["moved"]), want_moved))
                except GitError as exc:
                    problems.append("classify が失敗: {}".format(exc))

            mark = "OK" if not problems else "NG"
            print("[{}] {}".format(mark, name))
            if problems:
                for p in problems:
                    print("       {}".format(p))
                failures.append(name)
            print("-" * 60)

    print("")
    print("自己検証: {}/{} 件通過".format(len(cases) - len(failures), len(cases)))
    if failures:
        print("失敗: {}".format(", ".join(failures)), file=sys.stderr)
        if os.environ.get("GITHUB_ACTIONS"):
            print("::error::起点ずれ判定の自己検証が失敗しました: {}".format(", ".join(failures)))
        return EXIT_ERROR
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="ブランチが main の持つファイルを失っていないか検査する",
    )
    parser.add_argument("--base", default="origin/main", help="比較元（既定: origin/main）")
    parser.add_argument("--head", default="HEAD", help="比較先（既定: HEAD）")
    parser.add_argument("--repo", default=".", help="git リポジトリのパス（既定: カレント）")
    parser.add_argument("--allow-drift", action="store_true",
                        help="起点ずれを検出しても成功扱いにする（ラベルによる明示許可）")
    parser.add_argument("--self-test", action="store_true",
                        help="判定ロジック自身を使い捨てリポジトリで検証する")
    args = parser.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        # 日本語を含む出力で UnicodeEncodeError で落ちないようにする。
        # encoding は変えない(コンソールの文字化けを招くため)。
        sys.stdout.reconfigure(errors="replace")

    if args.self_test:
        return self_test()

    return run_check(args.repo, args.base, args.head, args.allow_drift)


if __name__ == "__main__":
    sys.exit(main())
