import { useEffect, useState } from "react";
import { api, ColumnInfo } from "./api";
import { useEscToClose, toast } from "./ui";
import { diffNameLists, diffColumns, NameDiff, ColumnDiff } from "./sql";

// 結構比對（對標 Navicat Premium 的結構同步）：比對同一連線下兩個資料庫的資料表與欄位差異。
// 全部以既有唯讀 API（listDatabases / listTables / tableColumns）達成，獨立對話框、不動既有畫面。
export default function SchemaCompare({ connId, sourceDb, onClose }: {
  connId: string;
  sourceDb: string;
  onClose: () => void;
}) {
  useEscToClose(onClose);
  const [dbs, setDbs] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [diff, setDiff] = useState<NameDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [colDiffs, setColDiffs] = useState<Record<string, ColumnDiff | "loading">>({});

  useEffect(() => {
    api.listDatabases(connId).then((list) => {
      const others = list.filter((d) => d !== sourceDb);
      setDbs(others);
      if (others.length) setTarget(others[0]);
    }).catch(() => {});
  }, [connId, sourceDb]);

  const compare = async () => {
    if (!target) return;
    setBusy(true); setDiff(null); setColDiffs({});
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
      const toSc = (c: ColumnInfo) => ({ name: c.name, data_type: c.data_type, nullable: c.nullable });
      setColDiffs((m) => ({ ...m, [table]: diffColumns(sc.map(toSc), tc.map(toSc)) }));
    } catch (e: any) {
      toast.error(e?.message ?? "欄位比對失敗");
      setColDiffs((m) => { const n = { ...m }; delete n[table]; return n; });
    }
  };

  const Section = ({ title, names, color }: { title: string; names: string[]; color: string }) => (
    <div>
      <div className="text-xs text-white/45 mb-1">{title}（{names.length}）</div>
      {names.length === 0 ? <div className="text-white/30 text-xs px-2">—</div> : (
        <div className="flex flex-wrap gap-1.5">
          {names.map((n) => <span key={n} className={`mono text-xs px-2 py-0.5 rounded border ${color}`}>{n}</span>)}
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[880px] max-w-[96vw] h-[82vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">結構比對</span>
          <span className="mono text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-300">來源：{sourceDb}</span>
          <span className="text-white/40 text-xs">→ 目標</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} title="目標資料庫"
            className="bg-[#0c1118] border border-white/15 rounded px-2 py-1 text-xs">
            {dbs.length === 0 && <option value="">（無其他資料庫）</option>}
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <button type="button" onClick={compare} disabled={busy || !target}
            className="text-xs px-2.5 py-1 rounded bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40">{busy ? "比對中…" : "比對"}</button>
          <button type="button" onClick={onClose} className="ml-auto text-white/40 hover:text-white">✕</button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4 text-sm">
          {!diff ? (
            <div className="text-white/40 text-xs">選擇目標資料庫後按「比對」。差異以來源為基準（僅來源有 = 目標需新增）。</div>
          ) : (
            <>
              <Section title="僅來源有（目標缺少）" names={diff.onlyInSource} color="border-green-500/40 text-green-300" />
              <Section title="僅目標有（來源缺少）" names={diff.onlyInTarget} color="border-red-500/40 text-red-300" />
              <div>
                <div className="text-xs text-white/45 mb-1">兩邊皆有（{diff.common.length}）— 點選比對欄位</div>
                <div className="space-y-1.5">
                  {diff.common.map((t) => {
                    const cd = colDiffs[t];
                    const hasDiff = cd && cd !== "loading" && (cd.added.length || cd.removed.length || cd.changed.length);
                    return (
                      <div key={t} className="rounded border border-white/10">
                        <button type="button" onClick={() => compareCols(t)}
                          className="w-full text-left px-3 py-1.5 mono text-xs hover:bg-white/5 flex items-center gap-2">
                          <span className="text-white/80">{t}</span>
                          {cd === "loading" && <span className="text-white/40">比對中…</span>}
                          {cd && cd !== "loading" && (hasDiff
                            ? <span className="text-amber-300">有差異</span>
                            : <span className="text-white/30">結構相同</span>)}
                        </button>
                        {cd && cd !== "loading" && hasDiff && (
                          <div className="px-3 py-2 border-t border-white/5 text-xs space-y-1">
                            {cd.added.length > 0 && <div><span className="text-green-300">＋ 目標需新增：</span><span className="mono text-white/70">{cd.added.join(", ")}</span></div>}
                            {cd.removed.length > 0 && <div><span className="text-red-300">－ 目標多出：</span><span className="mono text-white/70">{cd.removed.join(", ")}</span></div>}
                            {cd.changed.map((c) => (
                              <div key={c.name}><span className="text-amber-300 mono">{c.name}</span>
                                <span className="text-white/50">：來源 </span><span className="mono text-white/80">{c.source}</span>
                                <span className="text-white/50"> · 目標 </span><span className="mono text-white/80">{c.target}</span></div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
