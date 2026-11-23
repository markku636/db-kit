// Registry / Harbor 介面用的純函式（可單測）：pull 參照組裝、嚴重度色調、digest 縮寫。
import type { HarborScan } from "./registryTypes";

/** 後端回的 base URL（`https://harbor.corp:443/sub`）→ docker pull 用的主機（`harbor.corp`；非預設埠保留）。 */
export function registryHost(baseUrl: string): string {
  const m = /^(https?):\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?/i.exec(baseUrl.trim());
  if (!m) return baseUrl;
  const [, scheme, host, port] = m;
  const def = scheme.toLowerCase() === "https" ? "443" : "80";
  return port && port !== def ? `${host}:${port}` : host;
}

/** OCI digest 是 `<演算法>:<編碼>`，不限 sha256（sha512 也合法）。 */
function isDigest(ref: string): boolean {
  return /^[a-z][a-z0-9+._-]*:/i.test(ref);
}

/** `host/repo:tag` 或 `host/repo@<algorithm>:…`。 */
export function pullRef(host: string, repo: string, ref: string): string {
  return `${host}/${repo}${isDigest(ref) ? "@" : ":"}${ref}`;
}

export function shortDigest(d: string): string {
  // 保留原本的演算法前綴：sha512:abcdef… 不能變成 sha256:sha512:ab…。
  const m = /^([a-z][a-z0-9+._-]*):(.+)$/i.exec(d);
  if (m) {
    return m[2].length > 12 ? `${m[1]}:${m[2].slice(0, 12)}` : d;
  }
  return d.length > 12 ? d.slice(0, 12) : d;
}

export type SevTone = "danger" | "warning" | "info" | "neutral" | "success";

export function severityTone(sev: string): SevTone {
  switch (sev.toLowerCase()) {
    case "critical":
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "info";
    case "none":
      return "success";
    default:
      return "neutral";
  }
}

/** 掃描摘要的短字串：`C1 H2 M0 L3`（全 0 → 無弱點）。 */
export function scanSummary(s: HarborScan): string {
  const parts: string[] = [];
  if (s.critical) parts.push(`C${s.critical}`);
  if (s.high) parts.push(`H${s.high}`);
  if (s.medium) parts.push(`M${s.medium}`);
  if (s.low) parts.push(`L${s.low}`);
  if (s.unknown) parts.push(`?${s.unknown}`);
  return parts.join(" ");
}

/** 掃描還在跑（要輪詢、不能顯示「無弱點」）。Harbor 用 Queued / Scanning，
 *  不同版本還會見到 Pending / Running / Scheduled；比對時一律忽略大小寫。 */
export function scanInProgress(s: HarborScan | null): boolean {
  if (!s) return false;
  return new Set(["queued", "pending", "running", "scanning", "scheduled", "inprogress", "in_progress"])
    .has(s.status.trim().toLowerCase());
}
