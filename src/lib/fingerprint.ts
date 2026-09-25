/** 重複判定キー: SHA-256(agent_id|action|error_kind) の先頭16hex */
export async function computeFingerprint(agentId: string, action: string, errorKind: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`${agentId}|${action}|${errorKind}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
