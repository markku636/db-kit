// 斷線原因 → 給人看的類別。原始訊息多半是 OS 錯誤：Windows 依系統語系給英文或中文，後面帶 (os error N)；
// Linux / macOS 是 errno。提示列的標題用類別講人話，原文留在第二行給要查的人看。
// 錯誤碼：Windows WSA / Linux errno / macOS errno。

export type DisconnectKind = "reset" | "timeout" | "refused" | "unreachable" | "other";

const PATTERNS: [DisconnectKind, RegExp][] = [
  ["reset", /os error (10054|104|54)\b|ECONNRESET|forcibly closed|connection reset|強制關閉|重設/i],
  ["timeout", /os error (10060|110|60)\b|ETIMEDOUT|timed out|逾時|超時/i],
  ["refused", /os error (10061|111|61)\b|ECONNREFUSED|refused|拒絕/i],
  ["unreachable", /os error (10065|10051|113|101|65|51)\b|EHOSTUNREACH|ENETUNREACH|unreachable|無法連線到/i],
];

export function disconnectKind(reason: string | null | undefined): DisconnectKind {
  const r = String(reason ?? "");
  for (const [kind, re] of PATTERNS) if (re.test(r)) return kind;
  return "other";
}
