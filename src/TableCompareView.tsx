import { useEffect, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import { api, type DbSchema, type SyncStatement, type TableDiff, type TextChange } from "./api";
import { Button } from "./ui/index";
import { toast } from "./ui";
import { renameTableInSchema, type CompareTarget, type SchemaStatus } from "./compareModel";
import SchemaDiffView from "./SchemaDiffView";
import SyncScriptPanel, { type StatementOutcome } from "./SyncScriptPanel";
import { useT } from "./i18n";

/**
 * 單一資料表的結構比對本體（差異檢視 + 同步腳本）。
 * 單表對話框直接用；整庫對話框點某一列 drill-in 時，以已擷取好的兩側結構重用，不再重抓。
 */
export default function TableCompareView({ srcConnId, srcDb, srcTable, target, dstTable, srcLabel, dstLabel, preloaded, onUse, autoRun }: {
  srcConnId: string;
  srcDb: string;
  srcTable: string;
  target: CompareTarget;
  dstTable: string;
  srcLabel: string;
  dstLabel: string;
  /** 整庫模式已擷取的兩側結構（避免重抓）。 */
  preloaded?: { src: DbSchema; dst: DbSchema } | null;
  onUse: (sql: string, targetConnId: string) => void;
  /** 掛載時自動比對。 */
  autoRun?: boolean;
}) {
  const t = useT();
  const dstConnId = target.mode === "live" ? target.connId : null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<{
    status: SchemaStatus; diff: TableDiff | null; text: TextChange | null;
    srcDdl: string | null; dstDdl: string | null; statements: SyncStatement[]; skipped: string[];
  } | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      let src = preloaded?.src;
      let dst = preloaded?.dst;
      if (!src) src = await api.captureSchema(null, srcConnId, srcDb, srcLabel, { tables: [srcTable] });
      if (!dst) {
        if (target.mode === "live") dst = await api.captureSchema(null, target.connId, target.db, dstLabel, { tables: [dstTable] });
        else if (target.schema) dst = target.schema;
        else throw new Error(t("尚未選擇快照"));
      }
      // 目標表名可與來源不同（單表比對允許指定）→ 改名後才能以同名配對。
      const dstR = renameTableInSchema(dst, dstTable, srcTable);
      const d = await api.diffSchema(src, dstR);
      let status: SchemaStatus = "identical";
      let diff: TableDiff | null = null;
      let text: TextChange | null = null;
      if (d.tables_added.includes(srcTable) || d.views_added.includes(srcTable)) status = "source_only";
      else if (d.tables_removed.includes(srcTable) || d.views_removed.includes(srcTable)) status = "target_only";
      else {
        diff = d.tables_changed.find((x) => x.name === srcTable) ?? null;
        text = d.views_changed.find((x) => x.name === srcTable) ?? null;
        if (diff || text) status = "changed";
      }
      const srcT = src.tables.find((x) => x.name === srcTable) ?? src.views.find((x) => x.name === srcTable);
      const dstT = dstR.tables.find((x) => x.name === srcTable) ?? dstR.views.find((x) => x.name === srcTable);
      let statements: SyncStatement[] = [];
      let skipped: string[] = [];
      if (!d.cross_engine && status !== "identical") {
        const sc = await api.generateSchemaSync(src, dstR, undefined, { include_drops: true, include_routines: true }, [srcTable]);
        statements = sc.statements;
        skipped = sc.skipped;
      }
      setRes({ status, diff, text, srcDdl: srcT?.ddl ?? null, dstDdl: dstT?.ddl ?? null, statements, skipped });
    } catch (e: any) {
      setErr(e?.message ?? t("比對失敗"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autoRun) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const execute = async (stmts: SyncStatement[]): Promise<StatementOutcome[]> => {
    if (!dstConnId) return [];
    const out: StatementOutcome[] = [];
    for (let i = 0; i < stmts.length; i++) {
      try {
        await api.execDdl(dstConnId, stmts[i].sql);
        out.push({ index: i, ok: true });
      } catch (e: any) {
        out.push({ index: i, ok: false, error: e?.message ?? String(e) });
      }
    }
    const fails = out.filter((o) => !o.ok).length;
    if (fails === 0) toast.success(t("已成功執行 {ok} 句", { ok: out.length }));
    else toast.error(t("執行完成：{ok} 句成功，{fail} 句失敗", { ok: out.length - fails, fail: fails }));
    void run(); // 套用後重新比對，讓畫面反映目前狀態
    return out;
  };

  const statusText = !res ? "" :
    res.status === "identical" ? t("結構相同") :
      res.status === "changed" ? t("有差異") :
        res.status === "source_only" ? t("僅來源有") : t("僅目標有");

  return (
    <div className="flex flex-col gap-3 min-h-0">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={run} loading={busy} disabled={busy} icon={GitCompareArrows}>
          {res ? t("重新比對") : t("比對結構")}
        </Button>
        {res && (
          <span className={`text-xs ${res.status === "identical" ? "text-fg/40" : "text-amber-300"}`}>{statusText}</span>
        )}
        <span className="ml-auto text-[11px] text-fg/35 mono truncate max-w-[40ch]" title={`${srcLabel} · ${srcTable} → ${dstLabel} · ${dstTable}`}>
          {srcTable}{dstTable !== srcTable ? ` → ${dstTable}` : ""}
        </span>
      </div>

      {err && <div className="text-xs text-red-400 whitespace-pre-wrap break-words">{err}</div>}
      {res && <SchemaDiffView diff={res.diff} status={res.status} text={res.text} srcDdl={res.srcDdl} dstDdl={res.dstDdl} srcLabel={srcLabel} dstLabel={dstLabel} />}
      {!res && !busy && !err && <div className="text-xs text-fg/40">{t("按「比對結構」以擷取兩側結構並比對欄位 / 索引 / 外鍵。")}</div>}
      {res && (
        <SyncScriptPanel statements={res.statements} skipped={res.skipped}
          header={t("同步：{src} → {dst}", { src: `${srcLabel} · ${srcTable}`, dst: `${dstLabel} · ${dstTable}` })}
          dstConnId={dstConnId} dstLabel={dstLabel}
          onSend={dstConnId ? (sql) => onUse(sql, dstConnId) : undefined}
          onExecute={dstConnId ? execute : undefined} />
      )}
    </div>
  );
}
