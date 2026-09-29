// Docker 介面用的純函式（不碰 React / IPC，可單測）：格式化、狀態色調、環境變數遮罩、
// 連線 host 形式判讀（本機 socket / pipe 或 TCP）。

import type { ConnectionConfig } from "./api";
import type { DockerContainer, DockerPort } from "./dockerTypes";

/** 位元組 → 人類可讀（1024 進位，到 TB）。 */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Unix 秒 → 本地時間字串（0 / 負值回空）。 */
export function fmtUnix(sec: number): string {
  if (!sec || sec <= 0) return "";
  return new Date(sec * 1000).toLocaleString();
}

/** RFC3339（Docker inspect）→ 本地時間字串；Docker 的零值 `0001-01-01…` 回空。 */
export function fmtIso(iso: string): string {
  if (!iso || iso.startsWith("0001-01-01")) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export type StateTone = "success" | "warning" | "danger" | "info" | "neutral";

/** 容器狀態 → 徽章色調。 */
export function containerStateTone(state: string): StateTone {
  switch (state) {
    case "running":
      return "success";
    case "paused":
      return "warning";
    case "restarting":
      return "info";
    case "dead":
      return "danger";
    default:
      return "neutral";
  }
}

/** 樹節點的 objKind（`container-running`）→ 容器狀態；非容器回 null。 */
export function stateFromObjKind(objKind: string | undefined): string | null {
  if (!objKind || !objKind.startsWith("container-")) return null;
  return objKind.slice("container-".length);
}

/** 看起來是機密的環境變數名（顯示時預設遮罩）。 */
export function isSensitiveEnvKey(key: string): boolean {
  return /PASS|PWD|SECRET|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH/i.test(key);
}

/** `KEY=VALUE` → [key, value]（沒有 `=` 時 value 為空字串）。 */
export function splitEnv(entry: string): [string, string] {
  const i = entry.indexOf("=");
  return i < 0 ? [entry, ""] : [entry.slice(0, i), entry.slice(i + 1)];
}

/** env 陣列 → 物件（後出現者覆蓋前者，同 Docker 行為）。 */
export function envMap(env: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of env) {
    const [k, v] = splitEnv(e);
    out[k] = v;
  }
  return out;
}

/** 埠映射顯示：`0.0.0.0:15432 → 5432/tcp`；未發布只顯示 `5432/tcp`。 */
export function portLabel(p: DockerPort): string {
  const inner = `${p.private_port}/${p.proto || "tcp"}`;
  if (p.public_port == null) return inner;
  const ip = p.ip && p.ip !== "0.0.0.0" && p.ip !== "::" ? `${p.ip}:` : "";
  return `${ip}${p.public_port} → ${inner}`;
}

/** 容器依 compose 專案分組（無專案者歸到空字串組，排最後）。 */
export function groupByCompose(list: DockerContainer[]): { project: string; items: DockerContainer[] }[] {
  const m = new Map<string, DockerContainer[]>();
  for (const c of list) {
    const k = c.compose_project || "";
    const arr = m.get(k);
    if (arr) arr.push(c);
    else m.set(k, [c]);
  }
  return [...m.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([project, items]) => ({ project, items }));
}

/** host 欄是否為本機 socket / pipe 形式（空白＝本機預設）。 */
export function isLocalDockerHost(host: string): boolean {
  const h = host.trim();
  return (
    h === "" ||
    h === "local" ||
    h.startsWith("unix://") ||
    h.startsWith("npipe://") ||
    h.startsWith("/") ||
    h.startsWith("\\\\") ||
    h.startsWith("//./pipe/")
  );
}

/** 本機預設端點（僅顯示用；後端空白 host 即採用同一預設）。 */
export function defaultDockerSocket(isWindows: boolean): string {
  return isWindows ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";
}

/**
 * 從 Docker 連線推得「容器發布的埠要用哪個主機位址連」：本機 daemon → 127.0.0.1；
 * TCP daemon → 其主機名（去掉 scheme / 埠）。走 SSH 通道的連線也回 daemon 主機名——
 * 新建的資料庫連線會沿用同一組 SSH 設定，由跳板機去連它。
 */
export function dockerHostAddress(conn: Pick<ConnectionConfig, "host">): string {
  const h = conn.host.trim();
  if (isLocalDockerHost(h)) return "127.0.0.1";
  let rest = h.replace(/^(tcp|docker|https?):\/\//i, "");
  rest = rest.split("/")[0];
  if (rest.startsWith("[")) return rest.slice(1, rest.indexOf("]") > 0 ? rest.indexOf("]") : undefined);
  const colons = rest.split(":").length - 1;
  return colons === 1 ? rest.split(":")[0] : rest;
}
