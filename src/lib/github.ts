/**
 * GitHub Contents API へのコミット。
 *
 * 憲法: Cloudflare → GitHub → vault-sync → Obsidian の中継経路を守る。
 * Worker から WSL のファイルを直接触らない。
 * vault-intel(cloudflare/vault-intel/index.js) の HN パターンを移植したもの。
 */

const GITHUB_API = "https://api.github.com";

export interface CommitResult {
  ok: boolean;
  path?: string;
  commitUrl?: string;
  /** 失敗理由の分類。fingerprint を安定させるため詳細メッセージとは分ける */
  reason?: string;
  detail?: string;
}

/**
 * 日本語を含む文字列を base64 にする。
 * btoa() を直接呼ぶと非 ASCII で例外になるため、必ず UTF-8 バイト列を経由する。
 */
export function toBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    // Workers から GitHub API を叩くときは User-Agent 必須
    "User-Agent": "notify-gw-worker",
    Accept: "application/vnd.github+json",
  };
}

/**
 * repo の path にファイルを upsert する。
 * 既存があれば sha を取って上書き(冪等)。手動再実行で同じ日のファイルを作り直せる。
 * throw しない: 呼び出し側(日報送信)を失敗させないため、結果だけ返す。
 */
export async function commitFile(args: {
  token: string | undefined;
  repo: string;
  path: string;
  message: string;
  content: string;
}): Promise<CommitResult> {
  if (!args.token) {
    return { ok: false, reason: "token_not_configured" };
  }

  const apiUrl = `${GITHUB_API}/repos/${args.repo}/contents/${args.path}`;
  const h = headers(args.token);

  try {
    let sha: string | undefined;
    const getRes = await fetch(apiUrl, { headers: h });
    if (getRes.ok) {
      const existing = (await getRes.json()) as { sha?: string };
      sha = existing.sha;
    } else if (getRes.status === 401 || getRes.status === 403) {
      // トークン失効・権限不足。期限切れの沈黙を作らないよう種別を分ける
      return { ok: false, reason: `auth_${getRes.status}`, detail: (await getRes.text()).slice(0, 200) };
    } else if (getRes.status !== 404) {
      return { ok: false, reason: `get_${getRes.status}`, detail: (await getRes.text()).slice(0, 200) };
    }

    const body: Record<string, unknown> = {
      message: args.message,
      content: toBase64Utf8(args.content),
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!putRes.ok) {
      const reason = putRes.status === 401 || putRes.status === 403 ? `auth_${putRes.status}` : `put_${putRes.status}`;
      return { ok: false, reason, detail: (await putRes.text()).slice(0, 200) };
    }

    const created = (await putRes.json()) as { commit?: { html_url?: string } };
    return { ok: true, path: args.path, commitUrl: created.commit?.html_url };
  } catch (e) {
    return { ok: false, reason: "network_error", detail: e instanceof Error ? e.message : String(e) };
  }
}
