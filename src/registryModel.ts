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

/** `host/repo:tag` 或 `host/repo@sha256:…`。 */
export function pullRef(host: string, repo: string, ref: string): string {
  return ref.startsWith("sha256:") ? `${host}/${repo}@${ref}` : `${host}/${repo}:${ref}`;
}

export function shortDigest(d: string): string {
  const h = d.replace(/^sha256:/, "");
  return h.length > 12 ? `sha256:${h.slice(0, 12)}` : d;
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

/** 掃描還在跑（要輪詢）。 */
export function scanInProgress(s: HarborScan | null): boolean {
  return !!s && (s.status === "Running" || s.status === "Pending" || s.status === "Scheduled");
}
