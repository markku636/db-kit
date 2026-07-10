import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Database, Table2, Loader2 } from "lucide-react";
import { api, DbKind } from "./api";
import { useStore } from "./store";
import { toast } from "./ui";
import { Modal, Button, Select, Icon } from "./ui/index";
import { isSystemDatabase } from "./sql";
import { topoSortByFk } from "./fkorder";
import { useT } from "./i18n";

// 整庫資料傳輸（致敬 Navicat Data Transfer 的多表 / 整庫模式）：把來源庫的多張表
// 一次傳到另一連線 / 資料庫（目標同名表）。逐表複用已測試的 transfer_table。
const RELATIONAL: DbKind[] = ["mysql", "mariadb", "postgres", "sqlite"];

interface Outcome { table: string; transferred: number; failed: number; created: boolean; error?: string }

export default function DbTransferDialog({ connId, database, onClose }: {
  connId: string;
  database: string;
  onClose: () => void;
}) {
  const t = useT();
  const connections = useStore((s) => s.connections);
  const connectedIds = useStore((s) => s.connectedIds);
  const targetConns = useMemo(
    () => connections.filter((c) => RELATIONAL.includes(c.kind) && (connectedIds.has(c.id) || c.id === connId)),
    [connections, connectedIds, connId],
  );

  const [srcTables, setSrcTables] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const [dstId, setDstId] = useState(connId);
  const [dstDb, setDstDb] = useState("");
  const [dbs, setDbs] = useState<string[]>([]);
  const [createTable, setCreateTable] = useState(true);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);

  const dstKind = connections.find((c) => c.id === dstId)?.kind;
  const srcKind = connections.find((c) => c.id === connId)?.kind;
  const sameKind = srcKind === dstKind;
  const targetReadonly = useStore((s) => s.readonlyConns[dstId] === true);

  // 載入來源表（僅表）。
  useEffect(() => {
    api.listTables(connId, database)
      .then((ts) => {
        const names = ts.filter((item) => item.kind === "table").map((item) => item.name);
        setSrcTables(names);
        setPicked(new Set(names)); // 預設全選
      })
      .catch((e) => toast.error(e?.message ?? t("讀取資料表失敗")));
  }, [connId, database]);

  // 載入目標連線的資料庫清單。
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

  const sameDb = dstId === connId && dstDb === database;
  const visible = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? srcTables.filter((tbl) => tbl.toLowerCase().includes(f)) : srcTables;
  }, [srcTables, filter]);

  const toggle = (kind: string) => setPicked((p) => { const n = new Set(p); n.has(kind) ? n.delete(kind) : n.add(kind); return n; });

  const run = async () => {
    if (busy) return;
    const tables = srcTables.filter((tbl) => picked.has(tbl));
    if (tables.length === 0) { toast.error(t("請至少選一張資料表")); return; }
    if (sameDb) { toast.error(t("目標與來源是同一個資料庫")); return; }
    if (targetReadonly) { toast.error(t("目標連線為唯讀，無法寫入")); return; }
    if (createTable && !sameKind) { toast.error(t("自動建表僅支援相同資料庫種類")); return; }
    setBusy(true);
    setOutcomes(null);
    setProgress({ done: 0, total: tables.length });
    // 自動建表時：依外鍵相依排序（被參照的表先建），避免 CREATE 因外鍵指向尚未建立的表而失敗。
    let ordered = tables;
    if (createTable) {
      try {
        const model = await api.erModel(connId, database);
        ordered = topoSortByFk(tables, model.relations.map((r) => ({ from_table: r.from_table, to_table: r.to_table })));
      } catch { /* 取不到關係 → 沿用原順序 */ }
    }
    const results: Outcome[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const val = ordered[i];
      try {
        const res = await api.transferTable(connId, database, val, dstId, dstDb, val, { create_table: createTable, stop_on_error: false });
        results.push({ table: val, transferred: res.transferred, failed: res.failed, created: res.created });
      } catch (e: any) {
        results.push({ table: val, transferred: 0, failed: 0, created: false, error: e?.message ?? t("傳輸失敗") });
      }
      setProgress({ done: i + 1, total: tables.length });
    }
    setOutcomes(results);
    setBusy(false);
    const tot = results.reduce((a, r) => a + r.transferred, 0);
    const errs = results.filter((r) => r.error || r.failed > 0).length;
    if (errs === 0) toast.success(t("整庫傳輸完成：{length} 表 · {tot} 列", { length: results.length, tot }));
    else toast.error(t("完成：{length} 表，其中 {errs} 表有錯誤", { length: results.length, errs }));
  };

  const dbList = dstKind ? dbs.filter((d) => !isSystemDatabase(dstKind, d)) : dbs;

  return (
    <Modal
      onClose={onClose}
      title={<>{t("整庫資料傳輸 ·")} <span className="mono text-fg/60">{database}</span></>}
      icon={ArrowRight}
      size="lg"
      zClass="z-50"
      bodyClassName="p-5 space-y-4 overflow-auto"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{outcomes ? t("關閉") : t("取消")}</Button>
        <Button variant="primary" loading={busy} onClick={run} disabled={busy || picked.size === 0 || sameDb || targetReadonly}>
          {busy && progress ? t("傳輸中 {done}/{total}…", { done: progress.done, total: progress.total }) : t("傳輸選取的 {size} 表", { size: picked.size })}
        </Button>
      </>}
    >
      {/* 目標 */}
      <div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-x-2 gap-y-2 text-sm">
        <span className="text-xs text-fg/40">{t("目標連線")}</span>
        <Select selectSize="sm" value={dstId} onChange={(e) => { setDstId(e.target.value); setDstDb(""); }}>
          {targetConns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <span className="text-xs text-fg/40">{t("目標")}{dstKind === "postgres" ? " schema" : t("資料庫")}</span>
        {dstKind === "sqlite" ? (
          <span className="text-xs text-fg/60 mono">{dstDb || t("（檔案資料庫）")}</span>
        ) : (
          <Select selectSize="sm" value={dstDb} onChange={(e) => setDstDb(e.target.value)}>
            {!dbList.includes(dstDb) && dstDb && <option value={dstDb}>{dstDb}</option>}
            {dbList.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        )}
      </div>

      <label className={`flex items-center gap-2 text-sm cursor-pointer select-none ${sameKind ? "" : "opacity-40"}`}>
        <input type="checkbox" checked={createTable} disabled={!sameKind} onChange={(e) => setCreateTable(e.target.checked)} />
        <span>{t("目標表不存在時自動建立（沿用來源結構")}{sameKind ? "" : t("；限相同資料庫種類")}）</span>
      </label>

      <div className="flex items-start gap-1.5 text-[11px] text-fg/45">
        <Icon icon={Database} size={12} className="mt-0.5 shrink-0" />
        <span>{t("逐表以同名欄位交集傳到目標同名表。有外鍵的結構，建議目標表預先建好或確認建立順序。")}</span>
      </div>

      {/* 來源表多選 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-fg/50">{t("來源資料表（")}{picked.size}/{srcTables.length}）</span>
          <div className="flex items-center gap-2 text-[11px]">
            <button type="button" onClick={() => setPicked(new Set(srcTables))} className="text-accent hover:underline">{t("全選")}</button>
            <button type="button" onClick={() => setPicked(new Set())} className="text-accent hover:underline">{t("全不選")}</button>
          </div>
        </div>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("搜尋資料表…")}
          className="w-full mb-1 text-xs px-2 py-1 rounded border border-fg/15 bg-app outline-none" />
        <div className="max-h-52 overflow-auto rounded border border-fg/10 bg-app/40 p-1">
          {visible.map((item) => {
            const o = outcomes?.find((x) => x.table === item);
            return (
              <label key={item} className="flex items-center gap-2 px-2 py-0.5 text-xs hover:bg-fg/5 cursor-pointer">
                <input type="checkbox" checked={picked.has(item)} onChange={() => toggle(item)} />
                <Icon icon={Table2} size={12} className="text-fg/30" />
                <span className="truncate flex-1 mono">{item}</span>
                {busy && progress && !o && picked.has(item) && <Icon icon={Loader2} size={11} className="animate-spin text-fg/30" />}
                {o && (o.error || o.failed > 0
                  ? <span className="text-red-400 text-[10px]">{o.error ? t("失敗") : t("{transferred}／失敗 {failed}", { transferred: o.transferred, failed: o.failed })}</span>
                  : <span className="text-emerald-400 text-[10px]">{o.transferred} {t("列")}{o.created ? t(" · 已建表") : ""}</span>)}
              </label>
            );
          })}
          {visible.length === 0 && <div className="px-2 py-3 text-xs text-fg/40">{t("無相符資料表")}</div>}
        </div>
      </div>

      {sameDb && <div className="text-xs text-red-400">{t("目標與來源是同一個資料庫，請改選其他目標。")}</div>}
      {targetReadonly && <div className="text-xs text-amber-400">{t("目標連線為唯讀模式，無法寫入。")}</div>}

      {outcomes && (
        <div className="text-xs text-fg/60">
          {t("完成 {tables} 表 · 共傳輸 {rows} 列", { tables: outcomes.length, rows: outcomes.reduce((a, r) => a + r.transferred, 0) })}
          {outcomes.some((r) => r.error) && (
            <ul className="mt-1 text-red-300/80 mono max-h-24 overflow-auto list-disc pl-4">
              {outcomes.filter((r) => r.error).map((r) => <li key={r.table}>{r.table}：{r.error}</li>)}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
