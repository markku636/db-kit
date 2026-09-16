import { useEffect, useMemo, useState } from "react";
import { FileJson, Plug } from "lucide-react";
import { api, type DbKind } from "./api";
import { useStore } from "./store";
import { pickOpenFile, toast } from "./ui";
import { Button, Segmented, Select } from "./ui/index";
import { isSystemDatabase } from "./sql";
import { sameFamily, type CompareTarget } from "./compareModel";
import { useT } from "./i18n";

// 比對「目標側」選擇器：即時連線（同族且已連線；含來源連線本身）或結構快照檔（.json）。
// 供單表 / 整庫兩個比對對話框共用，避免各自再刻一份「連線 → 庫 → 表」三段下拉。
export default function CompareTargetPicker({
  srcConnId, srcKind, srcDb, srcTable, withTable, allowSnapshot, value, onChange, disabled,
}: {
  srcConnId: string;
  srcKind: DbKind;
  srcDb: string;
  srcTable?: string;
  withTable: boolean;
  allowSnapshot: boolean;
  value: CompareTarget;
  onChange: (v: CompareTarget) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const connections = useStore((s) => s.connections);
  const connectedIds = useStore((s) => s.connectedIds);
  const targetConns = useMemo(
    () => connections.filter((c) => sameFamily(c.kind, srcKind) && (connectedIds.has(c.id) || c.id === srcConnId)),
    [connections, connectedIds, srcConnId, srcKind],
  );

  const live = value.mode === "live" ? value : null;
  const dstId = live?.connId ?? srcConnId;
  const dstKind = connections.find((c) => c.id === dstId)?.kind;
  const [dbs, setDbs] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [loadingSnap, setLoadingSnap] = useState(false);

  // 目標連線的資料庫清單；未選時預設挑一個「不是來源」的庫——
  // 預設成來源庫會讓對話框一開就卡在「來源與目標相同」的錯誤狀態，比對鈕還是灰的。
  useEffect(() => {
    if (!live) return;
    let alive = true;
    api.listDatabases(live.connId)
      .then((d) => {
        if (!alive) return;
        setDbs(d);
        if (!live.db) {
          const userDbs = dstKind ? d.filter((x) => !isSystemDatabase(dstKind, x)) : d;
          const def = live.connId === srcConnId
            ? userDbs.find((x) => x !== srcDb) ?? srcDb // 同連線只有一個庫時才退回來源庫
            : userDbs[0] ?? d[0] ?? "";
          onChange({ ...live, db: def, table: withTable ? srcTable : undefined });
        }
      })
      .catch(() => { if (alive) setDbs([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.connId]);

  useEffect(() => {
    if (!live || !withTable || !live.db) { setTables([]); return; }
    let alive = true;
    api.listTables(live.connId, live.db)
      .then((ts) => {
        if (!alive) return;
        const names = ts.filter((x) => x.kind === "table").map((x) => x.name);
        setTables(names);
        if (!live.table || !names.includes(live.table)) {
          const def = srcTable && names.includes(srcTable) ? srcTable : names[0] ?? "";
          onChange({ ...live, table: def });
        }
      })
      .catch(() => { if (alive) setTables([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.connId, live?.db, withTable]);

  const pickSnapshot = async () => {
    const path = await pickOpenFile([{ name: t("結構快照"), extensions: ["json"] }]);
    if (!path) return;
    setLoadingSnap(true);
    try {
      const schema = await api.loadSchemaSnapshot(path);
      if (!sameFamily(schema.kind, srcKind)) {
        toast.error(t("快照與來源資料庫種類不同（{kind}）", { kind: schema.kind }));
        return;
      }
      onChange({ mode: "snapshot", path, schema });
    } catch (e: any) {
      toast.error(e?.message ?? t("讀取快照失敗"));
    } finally {
      setLoadingSnap(false);
    }
  };

  const dbList = dstKind ? dbs.filter((d) => !isSystemDatabase(dstKind, d)) : dbs;
  const snap = value.mode === "snapshot" ? value : null;

  return (
    <div className="space-y-2 text-sm">
      {allowSnapshot && (
        <Segmented
          ariaLabel={t("目標種類")}
          value={value.mode}
          onChange={(m) => onChange(m === "live" ? { mode: "live", connId: srcConnId, db: "", table: undefined } : { mode: "snapshot", path: "", schema: null })}
          options={[
            { value: "live", label: t("即時連線"), icon: Plug, disabled },
            { value: "snapshot", label: t("快照檔案"), icon: FileJson, disabled },
          ]}
        />
      )}
      {live && (
        <div className={`grid items-center gap-x-2 gap-y-2 ${withTable ? "grid-cols-[auto_1fr_auto_1fr_auto_1fr]" : "grid-cols-[auto_1fr_auto_1fr]"}`}>
          <span className="text-xs text-fg/40">{t("連線")}</span>
          <Select selectSize="sm" value={live.connId} disabled={disabled}
            onChange={(e) => onChange({ mode: "live", connId: e.target.value, db: "", table: undefined })}>
            {targetConns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <span className="text-xs text-fg/40">{dstKind === "postgres" ? "schema" : t("資料庫")}</span>
          {dstKind === "sqlite" ? (
            <span className="text-xs text-fg/60 mono truncate">{live.db || t("（檔案）")}</span>
          ) : (
            <Select selectSize="sm" value={live.db} disabled={disabled}
              onChange={(e) => onChange({ ...live, db: e.target.value, table: undefined })}>
              {!dbList.includes(live.db) && live.db && <option value={live.db}>{live.db}</option>}
              {dbList.map((d) => <option key={d} value={d}>{d}</option>)}
            </Select>
          )}
          {withTable && (
            <>
              <span className="text-xs text-fg/40">{t("資料表")}</span>
              <Select selectSize="sm" value={live.table ?? ""} disabled={disabled}
                onChange={(e) => onChange({ ...live, table: e.target.value })}>
                {tables.length === 0 && <option value="">{t("（此庫無資料表）")}</option>}
                {tables.map((tbl) => <option key={tbl} value={tbl}>{tbl}</option>)}
              </Select>
            </>
          )}
        </div>
      )}
      {snap && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" icon={FileJson} loading={loadingSnap} disabled={disabled} onClick={pickSnapshot}>{t("選擇快照檔…")}</Button>
          {snap.schema ? (
            <span className="mono text-xs px-2 py-0.5 rounded bg-fg/5 border border-fg/10 text-fg/70 truncate max-w-[60ch]" title={snap.path}>
              {snap.schema.kind} · {snap.schema.database} · {new Date(snap.schema.captured_at_ms).toLocaleString()} · {t("{n} 表", { n: snap.schema.tables.length })}
            </span>
          ) : (
            <span className="text-xs text-fg/40">{t("尚未選擇快照")}</span>
          )}
        </div>
      )}
    </div>
  );
}
