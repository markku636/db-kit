import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Database, Table2, AlertTriangle } from "lucide-react";
import { api, DbKind, TransferResult } from "./api";
import { useStore } from "./store";
import { toast } from "./ui";
import { Modal, Button, Select, Input, Icon } from "./ui/index";
import { buildDeleteAllRows, isSystemDatabase } from "./sql";
import { useT } from "./i18n";

// 資料傳輸（致敬 Navicat Data Transfer）：把來源表資料複製到另一連線 / 資料庫 / 表。
// 資料層級（目標表需先存在）：以同名欄位交集傳輸。可選傳輸前清空目標表。
const RELATIONAL: DbKind[] = ["mysql", "mariadb", "postgres", "sqlite"];

export default function TransferDialog({ connId, database, table, onClose }: {
  connId: string;
  database: string;
  table: string;
  onClose: () => void;
}) {
  const t = useT();
  const connections = useStore((s) => s.connections);
  const connectedIds = useStore((s) => s.connectedIds);

  // 可作為目標的連線：關聯式且已連線（含來源連線本身）。
  const targetConns = useMemo(
    () => connections.filter((c) => RELATIONAL.includes(c.kind) && (connectedIds.has(c.id) || c.id === connId)),
    [connections, connectedIds, connId],
  );

  const [dstId, setDstId] = useState(connId);
  const [dstDb, setDstDb] = useState("");
  const [dstTable, setDstTable] = useState("");
  const [dbs, setDbs] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [truncateFirst, setTruncateFirst] = useState(false);
  // 自動建表：目標表不存在時沿用來源 DDL 建立（限同種類）；勾選後改用「新表名」輸入。
  const [createTable, setCreateTable] = useState(false);
  const [newTable, setNewTable] = useState(`${table}_copy`);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TransferResult | null>(null);

  const dstKind = connections.find((c) => c.id === dstId)?.kind;
  const srcKind = connections.find((c) => c.id === connId)?.kind;
  const sameKind = srcKind === dstKind;
  // 目標連線唯讀時不可寫入（與查詢編輯器 / 資料格唯讀守門一致）。
  const targetReadonly = useStore((s) => s.readonlyConns[dstId] === true);
  // 實際目標表名：自動建表時用新表名，否則用下拉選的既有表。
  const effectiveTable = createTable ? newTable.trim() : dstTable;

  // 載入目標連線的資料庫清單。
  useEffect(() => {
    let alive = true;
    api.listDatabases(dstId)
      .then((d) => {
        if (!alive) return;
        const userDbs = dstKind ? d.filter((x) => !isSystemDatabase(dstKind, x)) : d;
        setDbs(d);
        // 同連線時預設沿用來源庫；否則取第一個使用者庫。
        setDstDb((cur) => cur || (dstId === connId ? database : userDbs[0] ?? d[0] ?? ""));
      })
      .catch(() => { if (alive) setDbs([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dstId]);

  // 載入目標庫的資料表清單（僅表，不含視圖）。
  useEffect(() => {
    if (!dstDb) { setTables([]); return; }
    let alive = true;
    api.listTables(dstId, dstDb)
      .then((ts) => {
        if (!alive) return;
        const names = ts.filter((item) => item.kind === "table").map((item) => item.name);
        setTables(names);
        // 預設不選中與來源同庫同名的表（避免自我傳輸）；否則選第一個。
        setDstTable((cur) => {
          if (cur && names.includes(cur)) return cur;
          const sameAsSource = dstId === connId && dstDb === database;
          return names.find((n) => !(sameAsSource && n === table)) ?? names[0] ?? "";
        });
      })
      .catch(() => { if (alive) setTables([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dstId, dstDb]);

  const isSameTable = dstId === connId && dstDb === database && effectiveTable === table;

  const run = async () => {
    if (busy || !effectiveTable) return;
    if (isSameTable) { toast.error(t("來源與目標是同一張表")); return; }
    if (targetReadonly) { toast.error(t("目標連線為唯讀，無法寫入")); return; }
    if (createTable && !sameKind) { toast.error(t("自動建表僅支援相同資料庫種類")); return; }
    setBusy(true);
    setResult(null);
    try {
      // 可選：傳輸前清空目標表（DELETE 全表）；自動建表時通常為新表，清空無妨。
      if (truncateFirst && dstKind && !createTable) {
        await api.runQuery(dstId, buildDeleteAllRows(dstKind, dstDb, effectiveTable));
      }
      const res = await api.transferTable(connId, database, table, dstId, dstDb, effectiveTable, {
        stop_on_error: false,
        create_table: createTable,
      });
      setResult(res);
      if (res.failed === 0) toast.success(res.created
        ? t("已傳輸 {n} 列（已建表）", { n: res.transferred })
        : t("已傳輸 {n} 列", { n: res.transferred }));
      else toast.error(t("傳輸 {transferred} 列、失敗 {failed} 列", { transferred: res.transferred, failed: res.failed }));
    } catch (e: any) {
      toast.error(e?.message ?? t("傳輸失敗"));
    } finally {
      setBusy(false);
    }
  };

  const dbList = dstKind ? dbs.filter((d) => !isSystemDatabase(dstKind, d)) : dbs;

  return (
    <Modal
      onClose={onClose}
      title={<>{t("資料傳輸 ·")} <span className="mono text-fg/60">{table}</span></>}
      icon={ArrowRight}
      size="md"
      zClass="z-50"
      bodyClassName="p-5 space-y-4 overflow-auto"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{result ? t("關閉") : t("取消")}</Button>
        <Button variant="primary" loading={busy} onClick={run} disabled={busy || !effectiveTable || isSameTable || targetReadonly}>{t("開始傳輸")}</Button>
      </>}
    >
      {/* 來源（唯讀） */}
      <div>
        <span className="text-xs text-fg/50 mb-1 block">{t("來源")}</span>
        <div className="flex items-center gap-1.5 text-sm rounded border border-fg/10 bg-inset px-2.5 py-1.5">
          <Icon icon={Table2} size={13} className="text-accent" />
          <span className="mono truncate">{connections.find((c) => c.id === connId)?.name} · {database} · {table}</span>
        </div>
      </div>

      <div className="flex justify-center text-fg/30"><Icon icon={ArrowRight} size={16} className="rotate-90" /></div>

      {/* 目標 */}
      <div className="space-y-2">
        <span className="text-xs text-fg/50 block">{t("目標")}</span>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-2 text-sm">
          <span className="text-xs text-fg/40">{t("連線")}</span>
          <Select selectSize="sm" value={dstId} onChange={(e) => { setDstId(e.target.value); setDstDb(""); setDstTable(""); }}>
            {targetConns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <span className="text-xs text-fg/40">{t("資料庫")}</span>
          {dstKind === "sqlite" ? (
            <span className="text-xs text-fg/60 mono">{dstDb || t("（檔案資料庫）")}</span>
          ) : (
            <Select selectSize="sm" value={dstDb} onChange={(e) => { setDstDb(e.target.value); setDstTable(""); }}>
              {!dbList.includes(dstDb) && dstDb && <option value={dstDb}>{dstDb}</option>}
              {dbList.map((d) => <option key={d} value={d}>{d}</option>)}
            </Select>
          )}
          <span className="text-xs text-fg/40">{t("資料表")}</span>
          {createTable ? (
            <Input inputSize="sm" value={newTable} onChange={(e) => setNewTable(e.target.value)} placeholder={t("新表名（將自動建立）")} />
          ) : (
            <Select selectSize="sm" value={dstTable} onChange={(e) => setDstTable(e.target.value)}>
              {tables.length === 0 && <option value="">{t("（此庫無資料表）")}</option>}
              {tables.map((tbl) => <option key={tbl} value={tbl}>{tbl}</option>)}
            </Select>
          )}
        </div>
      </div>

      <div className="flex items-start gap-1.5 text-[11px] text-fg/45">
        <Icon icon={Database} size={12} className="mt-0.5 shrink-0" />
        <span>{t("以「來源 ∩ 目標」的同名欄位傳輸；目標表需先存在或勾選自動建立。主鍵衝突的列會計為失敗並回報。")}</span>
      </div>

      <label className={`flex items-center gap-2 text-sm cursor-pointer select-none ${sameKind ? "" : "opacity-40"}`}>
        <input type="checkbox" checked={createTable} disabled={!sameKind}
          onChange={(e) => setCreateTable(e.target.checked)} />
        <span>{t("目標表不存在時自動建立（沿用來源結構")}{sameKind ? "" : t("；限相同資料庫種類")}）</span>
      </label>

      {!createTable && (
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input type="checkbox" checked={truncateFirst} onChange={(e) => setTruncateFirst(e.target.checked)} />
          <span className="inline-flex items-center gap-1">{t("傳輸前清空目標表")} <Icon icon={AlertTriangle} size={12} className="text-amber-400" /></span>
        </label>
      )}

      {isSameTable && <div className="text-xs text-red-400">{t("來源與目標是同一張表，請改選其他目標。")}</div>}
      {targetReadonly && <div className="text-xs text-amber-400">{t("目標連線為唯讀模式，無法寫入；請於連線右鍵關閉唯讀。")}</div>}

      {result && (
        <div className="mt-1 text-sm rounded border border-fg/10 bg-inset p-3 space-y-1">
          <div>
            <span className="text-emerald-400">{t("傳輸 {n} 列", { n: result.transferred })}</span>
            {result.failed > 0 && <> · <span className="text-red-400">{t("失敗 {n} 列", { n: result.failed })}</span></>}
            {result.created && <span className="ml-2 text-[11px] text-sky-300">{t("（已自動建立目標表）")}</span>}
          </div>
          <div className="text-xs text-fg/50">{t("欄位：")}<span className="mono">{result.columns.join(", ") || "—"}</span></div>
          {result.skipped_columns.length > 0 && (
            <div className="text-xs text-amber-300/80">{t("略過（目標無此欄）：")}<span className="mono">{result.skipped_columns.join(", ")}</span></div>
          )}
          {result.errors.length > 0 && (
            <ul className="text-xs text-red-300/80 mono max-h-32 overflow-auto list-disc pl-4">
              {result.errors.map((er, i) => <li key={i}>{er}</li>)}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
