import type { DbKind } from "./api";

// 從其他資料庫工具的連線設定檔匯入（只取連線位置與帳號，不取密碼——各工具用自己的金鑰加密密碼，
// 匯入後請在連線編輯補上）。支援：
// - DBeaver：workspace 裡的 `.dbeaver/data-sources.json`
// - DataGrip / IntelliJ：專案 `.idea/dataSources.xml`（帳號在旁邊的 dataSources.local.xml，兩份都能選）
// - `.ncx` 連線匯出檔（XML，每個 <Connection> 一筆）
// 純函式、不碰 DOM（vitest 在 node 跑）；XML 以標籤掃描處理。只有 JDBC URL 的項目由呼叫端交給後端
// parse_connection_url 補出 host / port / database。

export type ImportSource = "dbeaver" | "datagrip" | "ncx";

export interface ImportDraft {
  /** 來源工具裡的識別（DataGrip uuid、DBeaver id），用來把 local.xml 的帳號併回去。 */
  key: string;
  name: string;
  kind: DbKind | null;
  host?: string;
  port?: number;
  username?: string;
  database?: string;
  /** 只有 URL（JDBC）時留著，交給後端解析。 */
  url?: string;
  /** 來源工具裡的資料夾 / 群組名稱（僅顯示用）。 */
  folder?: string;
  ssh?: { host: string; port: number; username: string };
  source: ImportSource;
}

const KIND_HINTS: Array<[RegExp, DbKind]> = [
  [/maria/i, "mariadb"],
  [/mysql/i, "mysql"],
  [/postgres|pgsql|greenplum|redshift/i, "postgres"],
  [/sqlserver|mssql|jtds|azure_sql/i, "mssql"],
  [/oracle/i, "oracle"],
  [/sqlite/i, "sqlite"],
  [/mongo/i, "mongo"],
  [/redis/i, "redis"],
];

/** 由驅動名 / provider / JDBC URL 推斷種類；認不得回 null。 */
export function kindFromHint(...hints: Array<string | undefined | null>): DbKind | null {
  for (const h of hints) {
    if (!h) continue;
    for (const [re, k] of KIND_HINTS) if (re.test(h)) return k;
  }
  return null;
}

const toPort = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
};
const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// ---- DBeaver ----

export function parseDbeaver(json: string): ImportDraft[] {
  const root = JSON.parse(json) as { connections?: Record<string, Record<string, unknown>> };
  const out: ImportDraft[] = [];
  for (const [id, c] of Object.entries(root.connections ?? {})) {
    const cfg = (c.configuration ?? {}) as Record<string, unknown>;
    const url = nonEmpty(cfg.url);
    const kind = kindFromHint(String(c.driver ?? ""), String(c.provider ?? ""), url);
    const handlers = (cfg.handlers ?? {}) as Record<string, { enabled?: boolean; properties?: Record<string, unknown> }>;
    const sshH = handlers["ssh_tunnel"];
    const sshProps = sshH?.properties ?? {};
    out.push({
      key: id,
      name: nonEmpty(c.name) ?? id,
      kind,
      host: nonEmpty(cfg.host),
      port: toPort(cfg.port),
      username: nonEmpty(cfg.user),
      // SQLite 的資料庫是檔案路徑。
      database: nonEmpty(cfg.database),
      url,
      folder: nonEmpty(c.folder),
      ssh: sshH?.enabled && nonEmpty(sshProps.host)
        ? { host: String(sshProps.host), port: toPort(sshProps.port) ?? 22, username: nonEmpty(sshProps.user) ?? "" }
        : undefined,
      source: "dbeaver",
    });
  }
  return out;
}

// ---- XML 小工具（不需要完整的 XML parser：這兩種檔的結構很淺）----

function decodeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}
function childText(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? nonEmpty(decodeXml(m[1])) : undefined;
}

// ---- DataGrip ----

export function parseDataGrip(xml: string): ImportDraft[] {
  const out: ImportDraft[] = [];
  for (const m of xml.matchAll(/<data-source\b([^>]*)>([\s\S]*?)<\/data-source>/g)) {
    const a = attrsOf(m[1]);
    const body = m[2];
    const url = childText(body, "jdbc-url");
    out.push({
      key: a.uuid ?? a.name ?? String(out.length),
      name: a.name ?? a.uuid ?? "DataGrip",
      kind: kindFromHint(childText(body, "driver-ref"), url),
      username: childText(body, "user-name"),
      url,
      folder: a["group-name"],
      source: "datagrip",
    });
  }
  return out;
}

/** dataSources.local.xml 只有 uuid + 帳號：把帳號併回主檔解析出的項目。 */
export function mergeDataGripLocal(drafts: ImportDraft[], localXml: string): ImportDraft[] {
  const users = new Map<string, string>();
  for (const m of localXml.matchAll(/<data-source\b([^>]*)>([\s\S]*?)<\/data-source>/g)) {
    const a = attrsOf(m[1]);
    const u = childText(m[2], "user-name");
    if (a.uuid && u) users.set(a.uuid, u);
  }
  return drafts.map((d) => (d.username || !users.has(d.key) ? d : { ...d, username: users.get(d.key) }));
}

// ---- .ncx ----

const NCX_KIND: Record<string, DbKind> = {
  MYSQL: "mysql", MARIADB: "mariadb", POSTGRESQL: "postgres", SQLSERVER: "mssql", MSSQL: "mssql",
  ORACLE: "oracle", SQLITE: "sqlite", MONGODB: "mongo", REDIS: "redis",
};

export function parseNcx(xml: string): ImportDraft[] {
  const out: ImportDraft[] = [];
  for (const m of xml.matchAll(/<Connection\b([^>]*?)\/?>/g)) {
    const a = attrsOf(m[1]);
    const kind = NCX_KIND[(a.ConnType ?? "").toUpperCase()] ?? kindFromHint(a.ConnType);
    const sshOn = /^true$/i.test(a.SSH ?? "");
    out.push({
      key: a.ConnectionName ?? String(out.length),
      name: a.ConnectionName ?? "connection",
      kind,
      host: nonEmpty(a.Host),
      port: toPort(a.Port),
      username: nonEmpty(a.UserName),
      database: kind === "sqlite" ? nonEmpty(a.DatabaseFileName) : nonEmpty(a.Database ?? a.InitialDatabase ?? a.ServiceName),
      ssh: sshOn && nonEmpty(a.SSH_Host) ? { host: a.SSH_Host, port: toPort(a.SSH_Port) ?? 22, username: a.SSH_UserName ?? "" } : undefined,
      source: "ncx",
    });
  }
  return out;
}

/** 依副檔名與內容判斷格式並解析；認不得丟錯。 */
export function parseToolConnections(fileName: string, text: string): { source: ImportSource; drafts: ImportDraft[] } {
  const lower = fileName.toLowerCase();
  const t = text.replace(/^﻿/, "").trimStart();
  if (lower.endsWith(".ncx") || /<Connections\b/.test(t)) return { source: "ncx", drafts: parseNcx(t) };
  if (/<data-source\b/.test(t)) return { source: "datagrip", drafts: parseDataGrip(t) };
  if (t.startsWith("{")) return { source: "dbeaver", drafts: parseDbeaver(t) };
  throw new Error("unrecognized");
}
