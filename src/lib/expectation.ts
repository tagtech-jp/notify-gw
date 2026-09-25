/**
 * 「成功と言っているが実体があるか」の判定。
 *
 * 背景(2026-09-14 発覚):
 *   tagtech-automation の cron タスクは「[CIO] HackerNewsトレンド取得・Discord通知」という
 *   日本語の指示文をそのまま LLM に渡していた。LLM はこれを「その仕組みの作り方を教えてほしい」
 *   という依頼と解釈し、Python のサンプルコードや実装手順書を返していた。
 *   例外は出ないので notify-gw は result=success / severity=INFO を記録し、
 *   日報の「✅ 成功」に計上していた。**業務を一切していないのに成功と記録される**状態。
 *
 * ここでは送信側が「この出力にはこういう実体があるはず」を expect で宣言し、
 * 受信側(notify-gw)が機械的に検証する。
 *
 * **LLM は使わない。** 正規表現とカウントだけの決定論的判定。
 * 判定できないもの(expect 未指定)は従来どおり素通しする。
 */

/** 送信側が宣言する「期待する実体」 */
export type Expectation =
  /** 外部データを取得したはず。URL か数値が一定数含まれていなければ実体なしとみなす */
  | "external_data"
  /** そもそも LLM に投げるべきでない処理(API取得・期限計算・集計)。常に設計上の誤りとして報告する */
  | "deterministic"
  /** 検証しない(文章生成など、実体を機械判定できないもの) */
  | "none";

export interface ExpectationVerdict {
  expect: Expectation;
  ok: boolean;
  /** ok=false のときの機械可読な理由 */
  reason?: "no_verifiable_facts" | "deterministic_via_llm" | "empty_output";
  /** 判定に使った実測値。点だけで判断させないため必ず残す */
  facts?: { urls: number; numbers: number; length: number };
}

export const EXPECTATIONS: readonly Expectation[] = ["external_data", "deterministic", "none"] as const;

export function isExpectation(v: unknown): v is Expectation {
  return typeof v === "string" && (EXPECTATIONS as readonly string[]).includes(v);
}

/** 外部データの実体とみなす最低条件。URL 1本以上、または独立した数値 3 個以上 */
const MIN_URLS = 1;
const MIN_NUMBERS = 3;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
// コードブロックや手順書に出がちな連番(1. 2. 3.)・バージョン番号は実体とみなさない
const NUMBER_RE = /(?<![\w.])\d{2,}(?![\w.])/g;

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * 出力に検証可能な事実が含まれているかを判定する。
 * text は証跡に残っている出力(プレビューで可)。長さ 0 なら実体なし。
 */
export function evaluateExpectation(expect: Expectation, text: string | undefined | null): ExpectationVerdict {
  if (expect === "deterministic") {
    // 判定するまでもなく設計上の誤り。LLM は外部 API を叩けず、期限計算・集計も任せるべきではない
    return { expect, ok: false, reason: "deterministic_via_llm" };
  }
  if (expect === "none") return { expect, ok: true };

  const body = (text ?? "").trim();
  if (body.length === 0) return { expect, ok: false, reason: "empty_output", facts: { urls: 0, numbers: 0, length: 0 } };

  const facts = {
    urls: countMatches(body, URL_RE),
    numbers: countMatches(body, NUMBER_RE),
    length: body.length,
  };
  const ok = facts.urls >= MIN_URLS || facts.numbers >= MIN_NUMBERS;
  return ok ? { expect, ok, facts } : { expect, ok, reason: "no_verifiable_facts", facts };
}

/** 日報に出すときの人間向けの理由 */
export function reasonLabel(reason: ExpectationVerdict["reason"]): string {
  switch (reason) {
    case "deterministic_via_llm":
      return "設計上の誤り: 決定論的処理を LLM に委譲している";
    case "no_verifiable_facts":
      return "実体なし: 出力に URL も数値も無い(解説文の疑い)";
    case "empty_output":
      return "実体なし: 出力が空";
    default:
      return "";
  }
}
