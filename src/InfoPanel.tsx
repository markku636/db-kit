import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, KeyRound } from "lucide-react";
import { api, ColumnInfo, ConnectionConfig, DbKind, IndexInfo, KIND_META, PoolStatus } from "./api";
import Icon from "./ui/Icon";
import { IconButton } from "./ui/index";
import { useStore } from "./store";
import { databaseOptionsSql } from "./sql";
import { useT } from "./i18n";

// 右側「詳細資料」面板：單擊左側樹節點（連線 / 資料庫 / 資料表）即時顯示其唯讀摘要。
// 對標 Navicat 物件資訊面板；編輯仍走右鍵「屬性…」對話框，本面板僅檢視，避免誤改。
const PANEL_KEY = "db-kit:infoPanelOpen";
// 面板寬度持久化（px）；可拖曳左緣調整，夾在合理範圍內。
const WIDTH_KEY = "db-kit:infoPanelWidth";
const WIDTH_MIN = 240;
const WIDTH_MAX = 560;
const WIDTH_DEFAULT = 288; // 對應原本的 w-72

export default function InfoPanel() {
  const t = useT();
  const node = useStore((s) => s.selectedNode);
  const connections = useStore((s) => s.connections);
  const connectedIds = useStore((s) => s.connectedIds);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(PANEL_KEY) !== "0"; } catch { return true; }
  });
  const toggle = () =>
    setOpen((v) => {
      const next = !v;
      try { localStorage.setItem(PANEL_KEY, next ? "1" : "0"); } catch { /* 忽略 */ }
      return next;
    });

  const [width, setWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      return v >= WIDTH_MIN && v <= WIDTH_MAX ? v : WIDTH_DEFAULT;
    } catch { return WIDTH_DEFAULT; }
  });

  // 持久化面板寬度。
  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* 忽略 */ }
  }, [width]);

  // 拖曳左緣調整寬度（面板在右側，往左拖變寬）。
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) =>
      setWidth(Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, startW + (startX - ev.clientX))));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  // 收合狀態：僅留一條可點擊的窄邊條（保留垂直標題）。
  if (!open) {
    return (
      <div className="w-7 shrink-0 bg-panel border-l border-fg/10 flex flex-col items-center pt-2">
        <IconButton icon={ChevronLeft} label={t("顯示詳細資料面板")} iconSize={16} box="w-6 h-6"
          onClick={toggle} />
        <div className="mt-3 text-[10px] text-fg/30 tracking-wide [writing-mode:vertical-rl]">{t("詳細資料")}</div>
      </div>
    );
  }

  const conn = node ? connections.find((c) => c.id === node.connId) ?? null : null;
  const connected = !!conn && connectedIds.has(conn.id);

  return (
    <div className="shrink-0 bg-panel border-l border-fg/10 flex flex-col text-sm relative" style={{ width }}>
      <div onPointerDown={startResize} title={t("拖曳調整寬度")}
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 z-10" />
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-fg/10">
        <span className="text-xs text-fg/45 uppercase tracking-wide">{t("詳細資料")}</span>
        <IconButton icon={ChevronRight} label={t("收合面板")} iconSize={16} box="w-6 h-6"
          onClick={toggle} className="ml-auto" />
      </div>
      <div className="flex-1 overflow-auto">
        {!node || !conn ? (
          <div className="p-4 text-fg/30 text-xs leading-relaxed">
            {t("點選左側的連線、資料庫或資料表節點，這裡會顯示其詳細資料。")}
          </div>
        ) : node.type === "connection" ? (
          <ConnectionInfo key={conn.id} conn={conn} connected={connected} />
        ) : node.type === "database" ? (
          <DatabaseInfo
            key={`${conn.id}:${node.db}`}
            connId={conn.id} db={node.db} kind={node.kind} connected={connected}
          />
        ) : (
          <TableInfo
            key={`${conn.id}:${node.db}:${node.table}`}
            connId={conn.id} db={node.db} table={node.table}
            kind={node.kind} objKind={node.objKind}
          />
        )}
      </div>
    </div>
  );
}

// ---- 連線（伺服器）摘要 ----
function ConnectionInfo({ conn, connected }: { conn: ConnectionConfig; connected: boolean }) {
  const t = useT();
  const meta = KIND_META[conn.kind];
  const [ping, setPing] = useState<number | null>(null);
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [charset, setCharset] = useState<string | null>(null);
  const [dbCount, setDbCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  const refresh = () => {
    if (!connected) return;
    setBusy(true);
    const q1 = async (sql: string) => {
      try { return (await api.runQuery(conn.id, sql)).rows[0] ?? null; } catch { return null; }
    };
    (async () => {
      const [pg, pl] = await Promise.all([
        api.pingConnection(conn.id).catch(() => null),
        api.poolStatus(conn.id).catch(() => null),
      ]);
      // 伺服器版本 / 字元集：依種類用最穩定的查詢，失敗則略過該列。
      let ver: string | null = null;
      let cs: string | null = null;
      try {
        if (conn.kind === "mysql" || conn.kind === "mariadb") {
          // MariaDB 的 VERSION() 自然帶 -MariaDB 後綴，無需特別處理。
          const r = await q1("SELECT VERSION(), @@character_set_server, @@collation_server");
          if (r) { ver = r[0]; cs = [r[1], r[2]].filter(Boolean).join(" / ") || null; }
        } else if (conn.kind === "postgres") {
          ver = (await q1("SHOW server_version"))?.[0] ?? null;
          cs = (await q1("SHOW server_encoding"))?.[0] ?? null;
        } else if (conn.kind === "sqlite") {
          ver = (await q1("SELECT sqlite_version()"))?.[0] ?? null;
        } else if (conn.kind === "oracle") {
          // v$version 需權限，失敗退 product_component_version；字元集自 NLS 參數。
          ver = (await q1("SELECT banner FROM v$version WHERE ROWNUM = 1"))?.[0]
            ?? (await q1("SELECT version FROM product_component_version WHERE product LIKE 'Oracle%'"))?.[0]
            ?? null;
          cs = (await q1("SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET'"))?.[0] ?? null;
        } else if (conn.kind === "redis") {
          const secs = await api.serverInfo(conn.id).catch(() => []);
          for (const s of secs) {
            const hit = s.items.find(([k]) => k === "redis_version");
            if (hit) { ver = hit[1]; break; }
          }
        } else if (conn.kind === "mongo") {
          // serverStatus + buildInfo（伺服器區的「版本」列）。
          const secs = await api.serverInfo(conn.id).catch(() => []);
          for (const s of secs) {
            const hit = s.items.find(([k]) => k === t("版本"));
            if (hit) { ver = hit[1]; break; }
          }
        }
      } catch { /* 版本 / 字元集為加值資訊，失敗不影響其餘 */ }
      const dbs = await api.listDatabases(conn.id).catch(() => null);
      if (!aliveRef.current) return;
      setPing(pg); setPool(pl); setVersion(ver); setCharset(cs);
      setDbCount(dbs ? dbs.length : null);
      setBusy(false);
    })();
  };

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    return () => { aliveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, connected]);

  const cfgRows: [string, string][] = meta?.fileBased
    ? [[t("檔案路徑"), conn.host || "—"]]
    : [[t("主機"), `${conn.host}:${conn.port}`], [t("使用者"), conn.username || "—"]];
  cfgRows.unshift([t("類型"), meta?.label ?? conn.kind]);
  cfgRows.push([t("預設資料庫"), conn.database || "—"]);
  if (!meta?.fileBased) cfgRows.push([t("連線池上限"), String(conn.max_connections ?? "—")]);

  const sshRows: [string, string][] = conn.ssh_enabled
    ? [
        [t("SSH 主機"), `${conn.ssh_host ?? "—"}:${conn.ssh_port ?? 22}`],
        [t("SSH 使用者"), conn.ssh_username || "—"],
        [t("SSH 驗證"), conn.ssh_auth_method === "key" ? t("金鑰") : t("密碼")],
      ]
    : [];

  return (
    <div className="p-3 space-y-3">
      <Header dotColor={meta?.color ?? "#888"} title={conn.name}
        badge={connected ? t("已連線") : t("未連線")} badgeOk={connected} />

      <Section title={t("連線")}>
        {cfgRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
      </Section>

      {sshRows.length > 0 && (
        <Section title={t("SSH 通道")}>
          {sshRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
        </Section>
      )}

      <Section
        title={t("伺服器 / 即時")}
        action={connected ? (
          <button type="button" onClick={refresh} disabled={busy}
            className="text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-40">
            {busy ? t("更新中…") : t("重新整理")}
          </button>
        ) : undefined}
      >
        {!connected ? (
          <div className="text-fg/40 text-xs px-3 py-1.5">{t("未連線，無即時狀態。")}</div>
        ) : (
          <>
            {version && <Row k={t("伺服器版本")} v={version} />}
            {charset && <Row k={t("字元集 / 定序")} v={charset} />}
            {dbCount != null && <Row k={meta?.fileBased ? t("資料表") : t("資料庫數")} v={String(dbCount)} />}
            <Row k={t("連線延遲")} v={ping == null ? "—" : `${ping} ms`} />
            {!meta?.fileBased && (
              <Row k={t("連線池（用 / 閒 / 總）")}
                v={pool ? `${pool.in_use} / ${pool.idle} / ${pool.size}` : "—"} />
            )}
          </>
        )}
      </Section>
    </div>
  );
}

// ---- 資料庫 / Schema 摘要 ----
function DatabaseInfo({ connId, db, kind, connected }: {
  connId: string; db: string; kind: DbKind; connected: boolean;
}) {
  const t = useT();
  const [tables, setTables] = useState<number | null>(null);
  const [views, setViews] = useState<number | null>(null);
  const [charset, setCharset] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const objNoun = kind === "mongo" ? t("集合") : kind === "redis" ? t("鍵") : t("資料表");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ts = await api.listTables(connId, db);
        if (!alive) return;
        setTables(ts.filter((item) => item.kind !== "view").length);
        setViews(ts.filter((item) => item.kind === "view").length);
      } catch { if (alive) { setTables(null); setViews(null); } }
      if (kind === "mysql" || kind === "mariadb") {
        try {
          const r = await api.runQuery(connId, databaseOptionsSql(db));
          const row = r.rows[0];
          if (alive && row) setCharset([row[0], row[1]].filter(Boolean).join(" / ") || null);
        } catch { /* 略過 */ }
        try {
          const lit = `'${db.replace(/'/g, "''")}'`;
          const r = await api.runQuery(connId,
            `SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) ` +
            `FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${lit}`);
          const v = r.rows[0]?.[0];
          if (alive && v != null) setSize(`${v} MB`);
        } catch { /* 略過 */ }
      }
    })();
    return () => { alive = false; };
  }, [connId, db, kind, connected]);

  return (
    <div className="p-3 space-y-3">
      <Header dotColor="#64748b" title={db} badge={kind === "postgres" ? "Schema" : t("資料庫")} />
      <Section title={t("概要")}>
        <Row k={objNoun} v={tables == null ? "…" : String(tables)} />
        {views != null && views > 0 && <Row k={t("視圖")} v={String(views)} />}
        {charset && <Row k={t("字元集 / 定序")} v={charset} />}
        {size && <Row k={t("資料大小")} v={size} />}
      </Section>
      <div className="text-[11px] text-fg/30 px-1 leading-relaxed">
        {t("右鍵此節點可「設計表結構 / 結構比對 / 匯出結構 SQL」等更多操作。")}
      </div>
    </div>
  );
}

// ---- 資料表 / 視圖 / 集合摘要 ----
function TableInfo({ connId, db, table, kind, objKind }: {
  connId: string; db: string; table: string; kind: DbKind; objKind: string;
}) {
  const t = useT();
  const isMongo = kind === "mongo";
  const objLabel = isMongo ? t("集合") : objKind === "view" ? t("視圖") : t("資料表");
  const [cols, setCols] = useState<ColumnInfo[] | null>(null);
  const [idx, setIdx] = useState<IndexInfo[] | null>(null);
  const [stats, setStats] = useState<[string, string][] | null>(null);
  const [rows, setRows] = useState<number | "idle" | "loading" | "error">("idle");
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    api.tableColumns(connId, db, table).then((c) => aliveRef.current && setCols(c)).catch(() => aliveRef.current && setCols([]));
    api.tableIndexes(connId, db, table).then((i) => aliveRef.current && setIdx(i)).catch(() => aliveRef.current && setIdx([]));
    api.tableInfo(connId, db, table).then((s) => aliveRef.current && setStats(s)).catch(() => aliveRef.current && setStats([]));
    return () => { aliveRef.current = false; };
  }, [connId, db, table]);

  // 列數採點擊才算（大表 COUNT(*) 可能慢且佔連線），與 TableProperties 一致。
  const countRows = () => {
    setRows("loading");
    api.tableData(connId, db, table, { page: 1, page_size: 1, filters: [], sorts: [] })
      .then((d) => aliveRef.current && setRows(d.total_rows))
      .catch(() => aliveRef.current && setRows("error"));
  };

  return (
    <div className="p-3 space-y-3">
      <Header dotColor="#64748b" title={table} badge={objLabel} sub={db} />

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded border border-fg/10 px-2 py-2">
          <div className="text-[11px] text-fg/40">{t("列數")}</div>
          {rows === "idle" ? (
            <button type="button" onClick={countRows} className="text-xs text-blue-400 hover:text-blue-300 mt-0.5">{t("計算")}</button>
          ) : (
            <div className="text-sm mono text-fg/90 mt-0.5 truncate">
              {rows === "loading" ? "…" : rows === "error" ? "—" : rows.toLocaleString()}
            </div>
          )}
        </div>
        <Stat label={isMongo ? t("欄位*") : t("欄位")} value={cols == null ? "…" : String(cols.length)} />
        <Stat label={t("索引")} value={idx == null ? "…" : String(idx.length)} />
      </div>

      {stats && stats.length > 0 && (
        <Section title={t("統計")}>
          {stats.map(([k, v]) => <Row key={k} k={k} v={v} />)}
        </Section>
      )}

      <Section title={`欄位（${cols?.length ?? 0}）`}>
        {cols == null ? <Empty text={t("載入中…")} /> : cols.length === 0 ? <Empty text={t("（無）")} /> : (
          <div className="divide-y divide-fg/5">
            {cols.map((c) => (
              <div key={c.name} className="flex items-baseline gap-2 px-3 py-1">
                <span className="mono text-fg/85 truncate flex-1" title={c.name}>
                  {c.key === "PRI" && <span className="text-amber-300 mr-1 inline-flex items-center" title={t("主鍵")}><Icon icon={KeyRound} size={13} /></span>}
                  {c.name}
                </span>
                <span className="mono text-[11px] text-fg/40 shrink-0 max-w-[44%] truncate" title={c.data_type}>
                  {c.data_type}{!c.nullable && <span className="text-fg/25"> ·NN</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {idx && idx.length > 0 && (
        <Section title={t("索引（{length}）", { length: idx.length })}>
          <div className="divide-y divide-fg/5">
            {idx.map((ix) => (
              <div key={ix.name} className="px-3 py-1">
                <div className="flex items-baseline gap-2">
                  <span className="mono text-fg/80 truncate flex-1" title={ix.name}>{ix.name}</span>
                  {ix.primary && <span className="text-[10px] text-amber-300 shrink-0">PK</span>}
                  {!ix.primary && ix.unique && <span className="text-[10px] text-blue-300 shrink-0">UNIQUE</span>}
                </div>
                <div className="mono text-[11px] text-fg/40 truncate" title={ix.columns.join(", ")}>
                  {ix.columns.join(", ")}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ---- 共用呈現元件 ----
function Header({ dotColor, title, badge, badgeOk, sub }: {
  dotColor: string; title: string; badge?: string; badgeOk?: boolean; sub?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: dotColor }} />
      <span className="font-medium truncate" title={title}>{title}</span>
      {sub && <span className="text-[11px] text-fg/35 mono truncate">{sub}</span>}
      {badge && (
        <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
          badgeOk ? "bg-green-500/15 text-green-400" : "bg-fg/10 text-fg/45"
        }`}>{badge}</span>
      )}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center mb-1.5">
        <span className="text-[11px] text-fg/45 uppercase tracking-wide">{title}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="rounded border border-fg/10 divide-y divide-fg/5 overflow-hidden">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex px-3 py-1.5 gap-2">
      <span className="text-fg/45 w-24 shrink-0 text-xs">{k}</span>
      <span className="text-fg/85 mono break-all text-xs flex-1">{v}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-fg/10 px-2 py-2">
      <div className="text-[11px] text-fg/40">{label}</div>
      <div className="text-sm mono text-fg/90 mt-0.5 truncate">{value}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-fg/40 text-xs px-3 py-2">{text}</div>;
}
