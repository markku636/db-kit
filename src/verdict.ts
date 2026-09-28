// DBA 審查的結論（第一行 `VERDICT: GO|CAUTION|STOP`）：解析、顯示、會審合併。
//
// 契約本身在 ai-library/contracts/verdict.md（鎖定，使用者覆蓋不了）；解析規則與後端
// review_run::report::parse_verdict 一致——第一個非空行，容許 Markdown 粗體 / 標題記號與全形冒號。

export type Verdict = "go" | "caution" | "stop";

const VERDICT_RE = /^[*#\s]*VERDICT\s*[:：]?\s*\**\s*(GO|CAUTION|STOP)\b/i;

export function parseVerdict(text: string): Verdict | null {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const m = VERDICT_RE.exec(first);
  return m ? (m[1].toLowerCase() as Verdict) : null;
}

/** 顯示用：去掉開頭的 VERDICT 行（結論另外以徽章呈現）。 */
export function stripVerdictLine(text: string): string {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.trim().length > 0);
  if (idx < 0 || !VERDICT_RE.test(lines[idx].trim())) return text;
  return lines.slice(idx + 1).join("\n").replace(/^\n+/, "");
}

const RANK: Record<Verdict, number> = { go: 1, caution: 2, stop: 3 };

/**
 * 會審的綜合結論：取最嚴格者（STOP > CAUTION > GO）。
 * 有審查者沒給出結論（回覆格式不對、中途失敗）時視為 CAUTION——「沒意見」不能被當成「沒問題」。
 * 一個結論都沒有回 null。
 */
export function combineVerdicts(vs: readonly (Verdict | null | undefined)[]): Verdict | null {
  if (!vs.length) return null;
  let best: Verdict | null = null;
  for (const v of vs) {
    const x: Verdict = v ?? "caution";
    if (!best || RANK[x] > RANK[best]) best = x;
  }
  return best;
}
