import { useEffect, useMemo, useState } from "react";
import { GitCompare, ArrowRight, AlertTriangle } from "lucide-react";
import { api, DbKind } from "./api";
import { useStore } from "./store";
import { toast, copyToClipboard } from "./ui";
import { Modal, Button, Select, Icon } from "./ui/index";
import { isSystemDatabase } from "./sql";
import { diffRowsByPk, buildSyncDml, type RowSet, type RowDiff } from "./datasync";

// 資料比對 / 同步（致敬 Navicat Data Synchronization）：以主鍵比對來源 / 目標兩表的列，
// 算出 INSERT / UPDATE / DELETE 同步 DML（套用於目標）。產生的 DML 供檢視後執行，不自動套用。
const RELATIONAL: DbKind[] = ["mysql", "postgres", "sqlite"];
const CAP = 20000; // 每側比對列數上限（記憶體內比對）

export default function DataSyncDialog({ connId, database, table, onClose, onUse }: {
  connId: string;
  database: string;
  table: string;
  onClose: () => void;
  onUse: (sql: string, targetConnId: string) => void; // DML 套用於目標，故帶目標連線
}) {
  const connections = useStore((s) => s.connections);
  const connectedIds = useStore((s) => s.connectedIds);
  const targetConns = useMemo(
    () => connections.filter((c) => RELATIONAL.includes(c.kind) && (connectedIds.has(c.id) || c.id === connId)),
    [connections, connectedIds, connId],
  );

  const [dstId, setDstId] = useState(connId);
  const [dstDb, setDstDb] = useState("");
  const [dstTable, setDstTable] = useState("");
  const [dbs, setDbs] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [includeDeletes, setIncludeDeletes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<{ diff: RowDiff; src: RowSet; dstCols: string[]; capped: boolean } | null>(null);

  const dstKind = connections.find((c) => c.id === dstId)?.kind;

  useEffect(() => {
    let alive = true;
    api.listDatabases(dstId)
      .then((d) => {
        if (!alive) return;
        const userDbs = dstKind ? d.filter((x) => !isSystemDatabase(dstKind, x)) : d;
        setDbs(d);
        setDstDb((cur) => cur || (dstId === connId ? database : userDbs[0] ?? d[0] ?? ""));
      })
      .catch(() => { if (alive) setDbs([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dstId]);

  useEffect(() => {
    if (!dstDb) { setTables([]); return; }
    let alive = true;
    api.listTables(dstId, dstDb)
      .then((ts) => { if (alive) setTables(ts.filter((t) => t.kind === "table").map((t) => t.name)); })
      .catch(() => { if (alive) setTables([]); });
    return () => { alive = false; };
  }, [dstId, dstDb]);

  const sameTable = dstId === connId && dstDb === database && dstTable === table;

  const compare = async () => {
    if (busy || !dstTable) return;
    if (sameTable) { toast.error("來源與目標是同一張表"); return; }
    setBusy(true); setErr(null); setRes(null);
    try {
      const q = { page: 0, page_size: CAP, filters: [], sorts: [] };
      const [sp, dp] = await Promise.all([
        api.tableData(connId, database, table, q),
        api.tableData(dstId, dstDb, dstTable, q),
      ]);
      if (sp.primary_key.length === 0) { setErr("來源資料表沒有主鍵，無法以主鍵比對。"); return; }
      const src: RowSet = { columns: sp.columns, pk: sp.primary_key, rows: sp.rows };
      const dst: RowSet = { columns: dp.columns, pk: dp.primary_key, rows: dp.rows };
      const diff = diffRowsByPk(src, dst);
      setRes({ diff, src, dstCols: dp.columns, capped: sp.total_rows > CAP || dp.total_rows > CAP });
    } catch (e: any) {
      setErr(e?.message ?? "比對失敗");
    } finally {
      setBusy(false);
    }
  };

  const dml = useMemo(
    () => (res && dstKind ? buildSyncDml(dstKind, dstDb, dstTable, res.src, res.diff, includeDeletes, res.dstCols) : ""),
    [res, dstKind, dstDb, dstTable, includeDeletes],
  );

  const dbList = dstKind ? dbs.filter((d) => !isSystemDatabase(dstKind, d)) : dbs;
  const counts = res ? { i: res.diff.inserts.length, u: res.diff.updates.length, d: res.diff.deletes.length } : null;

  return (
    <Modal
      onClose={onClose}
      title={<>資料比對 / 同步 · <span className="mono text-fg/60">{table}</span></>}
      icon={GitCompare}
      size="lg"
      zClass="z-50"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={<>
        <Button variant="secondary" onClick={onClose}>關閉</Button>
        <Button onClick={() => copyToClipboard(dml)} disabled={!dml}>複製 DML</Button>
        <Button variant="primary" disabled={!dml} onClick={() => { onUse(dml, dstId); onClose(); }}>帶入查詢編輯器</Button>
      </>}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="mono text-fg/70 truncate">{connections.find((c) => c.id === connId)?.name} · {database} · {table}</span>
        <Icon icon={ArrowRight} size={14} className="text-fg/30 shrink-0" />
        <span className="text-xs text-fg/40 shrink-0">同步到 →</span>
      </div>

      <div className="grid grid-cols-[auto_1fr_auto_1fr_auto_1fr] items-center gap-x-2 gap-y-2 text-sm">
        <span className="text-xs text-fg/40">連線</span>
        <Select selectSize="sm" value={dstId} onChange={(e) => { setDstId(e.target.value); setDstDb(""); setDstTable(""); setRes(null); }}>
          {targetConns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <span className="text-xs text-fg/40">{dstKind === "postgres" ? "schema" : "資料庫"}</span>
        {dstKind === "sqlite" ? (
          <span className="text-xs text-fg/60 mono">{dstDb || "（檔案）"}</span>
        ) : (
          <Select selectSize="sm" value={dstDb} onChange={(e) => { setDstDb(e.target.value); setDstTable(""); setRes(null); }}>
            {!dbList.includes(dstDb) && dstDb && <option value={dstDb}>{dstDb}</option>}
            {dbList.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        )}
        <span className="text-xs text-fg/40">資料表</span>
        <Select selectSize="sm" value={dstTable} onChange={(e) => { setDstTable(e.target.value); setRes(null); }}>
          {tables.length === 0 && <option value="">（此庫無資料表）</option>}
          {tables.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={compare} loading={busy} disabled={busy || !dstTable || sameTable} icon={GitCompare}>比對</Button>
        <label className="inline-flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <input type="checkbox" checked={includeDeletes} onChange={(e) => setIncludeDeletes(e.target.checked)} />
          <span className="inline-flex items-center gap-1">含 DELETE（刪除目標多出的列）<Icon icon={AlertTriangle} size={12} className="text-amber-400" /></span>
        </label>
      </div>

      <div className="flex items-start gap-1.5 text-[11px] text-fg/45">
        <Icon icon={GitCompare} size={12} className="mt-0.5 shrink-0" />
        <span>以「來源」主鍵比對：目標缺 → INSERT、值有差 → UPDATE、目標多出 → DELETE（需勾選）。DML 套用於目標，供檢視後執行。</span>
      </div>

      {sameTable && <div className="text-xs text-red-400">來源與目標是同一張表。</div>}
      {err && <div className="text-xs text-red-400 whitespace-pre-wrap break-words">{err}</div>}

      {counts && (
        <div className="text-sm rounded border border-fg/10 bg-inset p-3 space-y-2">
          <div className="flex gap-4">
            <span>新增 <span className="text-emerald-400">{counts.i}</span></span>
            <span>更新 <span className="text-amber-300">{counts.u}</span></span>
            <span>刪除 <span className="text-red-400">{counts.d}</span>{!includeDeletes && counts.d > 0 ? "（未含）" : ""}</span>
          </div>
          {res?.capped && <div className="text-[11px] text-amber-300/80 inline-flex items-center gap-1"><Icon icon={AlertTriangle} size={11} />資料量超過 {CAP.toLocaleString()} 列上限，比對僅涵蓋前 {CAP.toLocaleString()} 列。</div>}
          {dml ? (
            <pre className="max-h-60 overflow-auto text-[11px] mono text-fg/75 whitespace-pre-wrap break-words bg-app/40 rounded p-2">{dml}</pre>
          ) : (
            <div className="text-xs text-fg/40">兩表資料一致，無需同步。</div>
          )}
        </div>
      )}
    </Modal>
  );
}
