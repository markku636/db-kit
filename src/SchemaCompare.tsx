import { useEffect, useState } from "react";
import { X, GitCompareArrows } from "lucide-react";
import { api, ColumnInfo, DbKind } from "./api";
import { toast, copyToClipboard } from "./ui";
import { Modal, IconButton } from "./ui/index";
import { diffNameLists, diffColumns, buildAddColumnsDdl, buildModifyColumnsDdl, NameDiff, ColumnDiff, SchemaColumn } from "./sql";

// 結構比對（對標 Navicat Premium 的結構同步）：比對同一連線下兩個資料庫的資料表與欄位差異。
// 全部以既有唯讀 API（listDatabases / listTables / tableColumns）達成，獨立對話框、不動既有畫面。
export default function SchemaCompare({ connId, kind, sourceDb, onClose }: {
  connId: string;
  kind: DbKind;
  sourceDb: string;
  onClose: () => void;
}) {
  const [dbs, setDbs] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [diff, setDiff] = useState<NameDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [colDiffs, setColDiffs] = useState<Record<string, { diff: ColumnDiff; addCols: SchemaColumn[]; changedCols: SchemaColumn[] } | "loading">>({});
  const [syncSql, setSyncSql] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);

  useEffect(() => {
    api.listDatabases(connId).then((list) => {
      const others = list.filter((d) => d !== sourceDb);
      setDbs(others);
      if (others.length) setTarget(others[0]);
    }).catch(() => {});
  }, [connId, sourceDb]);

  // 產生「缺少資料表」的 CREATE 語句（取來源端 DDL，於目標執行即補齊）。供使用者檢視 / 複製後執行。
  const genSyncSql = async (tables: string[]) => {
    setGenBusy(true);
    try {
      const ddls = await Promise.all(tables.map((t) => api.tableDdl(connId, sourceDb, t).catch(() => `-- 取得 ${t} 的 DDL 失敗`)));
      setSyncSql(
        `-- 於目標資料庫「${target}」執行以補齊來源「${sourceDb}」有而目標缺少的資料表\n\n` +
        ddls.map((d) => d.trim().replace(/;?\s*$/, ";")).join("\n\n"),
      );
    } catch (e: any) {
      toast.error(e?.message ?? "產生失敗");
    } finally {
      setGenBusy(false);
    }
  };

  const compare = async () => {
    if (!target) return;
    setBusy(true); setDiff(null); setColDiffs({}); setSyncSql(null);
    try {
      const [s, t] = await Promise.all([api.listTables(connId, sourceDb), api.listTables(connId, target)]);
      setDiff(diffNameLists(s.map((x) => x.name), t.map((x) => x.name)));
    } catch (e: any) {
      toast.error(e?.message ?? "比對失敗");
    } finally {
      setBusy(false);
    }
  };

  const compareCols = async (table: string) => {
    if (colDiffs[table]) return;
    setColDiffs((m) => ({ ...m, [table]: "loading" }));
    try {
      const [sc, tc] = await Promise.all([
        api.tableColumns(connId, sourceDb, table),
        api.tableColumns(connId, target, table),
      ]);
      const toSc = (c: ColumnInfo): SchemaColumn => ({ name: c.name, data_type: c.data_type, nullable: c.nullable });
      const srcCols = sc.map(toSc);
      const diffRes = diffColumns(srcCols, tc.map(toSc));
      const addCols = srcCols.filter((c) => diffRes.added.includes(c.name));
      const changedNames = new Set(diffRes.changed.map((c) => c.name));
      const changedCols = srcCols.filter((c) => changedNames.has(c.name));
      setColDiffs((m) => ({ ...m, [table]: { diff: diffRes, addCols, changedCols } }));
    } catch (e: any) {
      toast.error(e?.message ?? "欄位比對失敗");
      setColDiffs((m) => { const n = { ...m }; delete n[table]; return n; });
    }
  };

  const Section = ({ title, names, color }: { title: string; names: string[]; color: string }) => (
    <div>
      <div className="text-xs text-fg/45 mb-1">{title}（{names.length}）</div>
      {names.length === 0 ? <div className="text-fg/30 text-xs px-2">—</div> : (
        <div className="flex flex-wrap gap-1.5">
          {names.map((n) => <span key={n} className={`mono text-xs px-2 py-0.5 rounded border ${color}`}>{n}</span>)}
        </div>
      )}
    </div>
  );

  return (
    <Modal onClose={onClose} title="結構比對" icon={GitCompareArrows} size="xl" zClass="z-[95]"
      className="!w-[880px] max-w-[96vw] h-[82vh]"
      bodyClassName="flex-1 overflow-auto p-4 space-y-4 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="mono text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-300">來源：{sourceDb}</span>
        <span className="text-fg/40 text-xs">→ 目標</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} title="目標資料庫"
          className="bg-well border border-fg/15 rounded px-2 py-1 text-xs focus:border-accent">
          {dbs.length === 0 && <option value="">（無其他資料庫）</option>}
          {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button type="button" onClick={compare} disabled={busy || !target}
          className="text-xs px-2.5 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">{busy ? "比對中…" : "比對"}</button>
      </div>

      {!diff ? (
            <div className="text-fg/40 text-xs">選擇目標資料庫後按「比對」。差異以來源為基準（僅來源有 = 目標需新增）。</div>
          ) : (
            <>
              <Section title="僅來源有（目標缺少）" names={diff.onlyInSource} color="border-green-500/40 text-green-300" />
              {diff.onlyInSource.length > 0 && (
                <button type="button" onClick={() => genSyncSql(diff.onlyInSource)} disabled={genBusy}
                  className="text-xs px-2.5 py-1 rounded bg-green-600/80 hover:bg-green-600 disabled:opacity-40">
                  {genBusy ? "產生中…" : `產生缺少 ${diff.onlyInSource.length} 表的 CREATE SQL`}</button>
              )}
              {syncSql && (
                <div className="rounded border border-fg/10">
                  <div className="px-3 py-1.5 border-b border-fg/10 flex items-center gap-2 text-xs">
                    <span className="text-fg/60">同步 SQL（檢視後於目標執行）</span>
                    <button type="button" onClick={() => copyToClipboard(syncSql)}
                      className="ml-auto text-blue-400 hover:text-blue-300">複製</button>
                    <IconButton icon={X} label="關閉" iconSize={14} onClick={() => setSyncSql(null)} />
                  </div>
                  <textarea readOnly value={syncSql} title="同步 SQL"
                    className="w-full h-40 bg-well p-3 mono text-xs text-fg/80 resize-y outline-none" />
                </div>
              )}
              <Section title="僅目標有（來源缺少）" names={diff.onlyInTarget} color="border-red-500/40 text-red-300" />
              <div>
                <div className="text-xs text-fg/45 mb-1">兩邊皆有（{diff.common.length}）— 點選比對欄位</div>
                <div className="space-y-1.5">
                  {diff.common.map((t) => {
                    const cd = colDiffs[t];
                    const d = cd && cd !== "loading" ? cd.diff : null;
                    const hasDiff = d && (d.added.length || d.removed.length || d.changed.length);
                    return (
                      <div key={t} className="rounded border border-fg/10">
                        <button type="button" onClick={() => compareCols(t)}
                          className="w-full text-left px-3 py-1.5 mono text-xs hover:bg-fg/5 flex items-center gap-2">
                          <span className="text-fg/80">{t}</span>
                          {cd === "loading" && <span className="text-fg/40">比對中…</span>}
                          {d && (hasDiff
                            ? <span className="text-amber-300">有差異</span>
                            : <span className="text-fg/30">結構相同</span>)}
                        </button>
                        {d && hasDiff && (
                          <div className="px-3 py-2 border-t border-fg/5 text-xs space-y-1">
                            {d.added.length > 0 && <div><span className="text-green-300">＋ 目標需新增：</span><span className="mono text-fg/70">{d.added.join(", ")}</span></div>}
                            {d.removed.length > 0 && <div><span className="text-red-300">－ 目標多出：</span><span className="mono text-fg/70">{d.removed.join(", ")}</span></div>}
                            {d.changed.map((c) => (
                              <div key={c.name}><span className="text-amber-300 mono">{c.name}</span>
                                <span className="text-fg/50">：來源 </span><span className="mono text-fg/80">{c.source}</span>
                                <span className="text-fg/50"> · 目標 </span><span className="mono text-fg/80">{c.target}</span></div>
                            ))}
                            <div className="flex gap-3 mt-1">
                              {cd !== "loading" && cd.addCols.length > 0 && (
                                <button type="button"
                                  onClick={() => copyToClipboard(buildAddColumnsDdl(kind, target, t, cd.addCols), "已複製 ADD COLUMN SQL")}
                                  className="text-blue-400 hover:text-blue-300">複製補欄位 SQL</button>
                              )}
                              {cd !== "loading" && cd.changedCols.length > 0 && (
                                <button type="button"
                                  onClick={() => copyToClipboard(buildModifyColumnsDdl(kind, target, t, cd.changedCols), "已複製 MODIFY SQL")}
                                  className="text-amber-400 hover:text-amber-300">複製改型別 SQL</button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
    </Modal>
  );
}
