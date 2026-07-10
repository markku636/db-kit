import { useEffect, useRef, useState } from "react";
import { Table2 } from "lucide-react";
import { api, ColumnInfo, DbKind, IndexInfo } from "./api";
import { toast, uiConfirm } from "./ui";
import { Modal, Button } from "./ui/index";
import { tableOptionsSql, buildAlterTableOptions, buildConvertCharset } from "./sql";
import { useT } from "./i18n";

const TABLE_ENGINES = ["InnoDB", "MyISAM", "MEMORY", "ARCHIVE", "CSV"];
const CHARSETS = ["utf8mb4", "utf8", "latin1", "ascii", "big5", "gbk", "gb2312", "utf16"];

// 資料表 / 視圖 / 集合屬性：唯讀彙整欄位、索引與列數（沿用既有 API，免後端改動）。
export default function TableProperties({ connId, db, table, kind, objKind, onClose }: {
  connId: string;
  db: string;
  table: string;
  kind: DbKind;
  objKind: string; // "table" | "view"（Mongo 為集合）
  onClose: () => void;
}) {
  const t = useT();
  const [cols, setCols] = useState<ColumnInfo[] | null>(null);
  const [idx, setIdx] = useState<IndexInfo[] | null>(null);
  // 列數採點擊才計算（大表 COUNT(*) 可能較慢且佔用連線，不在開啟時自動跑）。
  const [rows, setRows] = useState<number | "idle" | "loading" | "error">("idle");
  const [stats, setStats] = useState<[string, string][] | null>(null); // 引擎 / 大小 / 列數估計…
  const aliveRef = useRef(true);

  const isMongo = kind === "mongo";
  const objLabel = isMongo ? t("集合") : objKind === "view" ? t("視圖") : t("資料表");
  // 可編輯選項（僅 MySQL 系資料表）：引擎 / 註解 / AUTO_INCREMENT。
  const optionsEditable = (kind === "mysql" || kind === "mariadb") && objKind !== "view";
  const [engine, setEngine] = useState("");
  const [comment, setComment] = useState("");
  const [autoInc, setAutoInc] = useState("");
  const [orig, setOrig] = useState<{ engine: string; comment: string; autoInc: string } | null>(null);
  const [savingOpts, setSavingOpts] = useState(false);
  const [curCollation, setCurCollation] = useState("");
  const [charset, setCharset] = useState("utf8mb4");
  const [collation, setCollation] = useState("");
  const [converting, setConverting] = useState(false);

  const loadStats = () => {
    api.tableInfo(connId, db, table).then((s) => aliveRef.current && setStats(s)).catch(() => aliveRef.current && setStats([]));
  };
  const loadOptions = () => {
    if (!optionsEditable) return;
    api.runQuery(connId, tableOptionsSql(db, table)).then((r) => {
      if (!aliveRef.current || r.rows.length === 0) return;
      const [e, c, ai, coll] = r.rows[0];
      setEngine(e ?? ""); setComment(c ?? ""); setAutoInc(ai ?? "");
      setOrig({ engine: e ?? "", comment: c ?? "", autoInc: ai ?? "" });
      setCurCollation(coll ?? "");
      // 預設字元集取現有定序的前綴（如 utf8mb4_general_ci → utf8mb4）。
      if (coll) { const cs = coll.split("_")[0]; if (CHARSETS.includes(cs)) setCharset(cs); }
    }).catch(() => {});
  };

  useEffect(() => {
    aliveRef.current = true;
    api.tableColumns(connId, db, table).then((c) => aliveRef.current && setCols(c)).catch(() => aliveRef.current && setCols([]));
    api.tableIndexes(connId, db, table).then((i) => aliveRef.current && setIdx(i)).catch(() => aliveRef.current && setIdx([]));
    loadStats();
    loadOptions();
    return () => { aliveRef.current = false; };
  }, [connId, db, table]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyOptions = async () => {
    if (!orig) return;
    const opts: { engine?: string; comment?: string; autoIncrement?: number } = {};
    if (engine && engine !== orig.engine) opts.engine = engine;
    if (comment !== orig.comment) opts.comment = comment;
    if (autoInc !== orig.autoInc && autoInc.trim() !== "" && Number.isFinite(Number(autoInc)))
      opts.autoIncrement = Number(autoInc);
    const sql = buildAlterTableOptions(db, table, opts);
    if (!sql) { toast.info(t("沒有變更")); return; }
    setSavingOpts(true);
    try {
      await api.execDdl(connId, sql);
      toast.success(t("資料表選項已更新"));
      loadStats(); loadOptions();
    } catch (e: any) {
      toast.error(e?.message ?? t("更新失敗"));
    } finally {
      setSavingOpts(false);
    }
  };

  const convertCharset = async () => {
    if (!(await uiConfirm(
      `將資料表「${table}」轉換為字元集 ${charset}${collation.trim() ? ` / ${collation.trim()}` : ""}？\n此操作會重寫所有文字欄位，大表可能較久且鎖表。`,
      { title: t("轉換字元集"), danger: true, confirmText: t("轉換") }))) return;
    setConverting(true);
    try {
      await api.execDdl(connId, buildConvertCharset(db, table, charset, collation));
      toast.success(t("字元集已轉換"));
      loadStats(); loadOptions();
    } catch (e: any) {
      toast.error(e?.message ?? t("轉換失敗"));
    } finally {
      setConverting(false);
    }
  };

  const countRows = () => {
    setRows("loading");
    api
      .tableData(connId, db, table, { page: 1, page_size: 1, filters: [], sorts: [] })
      .then((d) => aliveRef.current && setRows(d.total_rows))
      .catch(() => aliveRef.current && setRows("error"));
  };

  return (
    <Modal
      onClose={onClose}
      icon={Table2}
      size="md"
      zClass="z-[95]"
      bodyClassName="p-5 space-y-4 overflow-auto text-sm"
      title={
        <span className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate">{table}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-fg/10 text-fg/50">{objLabel}</span>
          <span className="text-xs text-fg/40 mono">{db}</span>
        </span>
      }
      footer={<Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>}
    >
      <div className="grid grid-cols-3 gap-2">
            <div className="rounded border border-fg/10 px-3 py-2">
              <div className="text-xs text-fg/40">{t("列數")}</div>
              {rows === "idle" ? (
                <button type="button" onClick={countRows} className="text-sm text-blue-400 hover:text-blue-300 mt-0.5">{t("點此計算")}</button>
              ) : (
                <div className="text-base mono text-fg/90 mt-0.5">
                  {rows === "loading" ? t("計算中…") : rows === "error" ? "—" : rows.toLocaleString()}
                </div>
              )}
            </div>
            <Stat label={isMongo ? t("欄位（取樣）") : t("欄位數")} value={cols == null ? "…" : String(cols.length)} />
            <Stat label={t("索引數")} value={idx == null ? "…" : String(idx.length)} />
          </div>

          {stats && stats.length > 0 && (
            <Section title={t("統計")}>
              {stats.map(([k, v]) => (
                <div key={k} className="flex px-3 py-1.5 gap-3">
                  <span className="text-fg/45 w-28 shrink-0">{k}</span>
                  <span className="text-fg/85 mono break-all">{v}</span>
                </div>
              ))}
            </Section>
          )}

          {optionsEditable && (
            <Section title={t("選項（可編輯）")}>
              <div className="px-3 py-2.5 space-y-2.5">
                <div className="flex items-center gap-3">
                  <span className="text-fg/45 w-20 shrink-0 text-xs">{t("引擎")}</span>
                  <select value={engine} onChange={(e) => setEngine(e.target.value)} title={t("儲存引擎")}
                    className="bg-well border border-fg/15 rounded px-2 py-1 text-xs focus:border-accent min-w-[140px]">
                    {engine && !TABLE_ENGINES.includes(engine) && <option value={engine}>{engine}</option>}
                    {TABLE_ENGINES.map((en) => <option key={en} value={en}>{en}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-fg/45 w-20 shrink-0 text-xs">AUTO_INCREMENT</span>
                  <input value={autoInc} onChange={(e) => setAutoInc(e.target.value.replace(/[^0-9]/g, ""))}
                    className="bg-well border border-fg/15 rounded px-2 py-1 text-xs focus:border-accent w-32 mono" placeholder="—" />
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-fg/45 w-20 shrink-0 text-xs mt-1">{t("註解")}</span>
                  <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
                    className="bg-well border border-fg/15 rounded px-2 py-1 text-xs focus:border-accent flex-1 resize-none" placeholder={t("（無）")} />
                </div>
                <div className="flex justify-end">
                  <button type="button" onClick={applyOptions} disabled={savingOpts || !orig}
                    className="px-3 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">
                    {savingOpts ? t("套用中…") : t("套用")}</button>
                </div>

                <div className="border-t border-fg/10 pt-2.5 space-y-2">
                  <div className="text-fg/40 text-[11px]">
                    {t("字元集轉換")}{curCollation ? t(" · 目前定序：{curCollation}", { curCollation }) : ""}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <select value={charset} onChange={(e) => setCharset(e.target.value)} title={t("字元集")}
                      className="bg-well border border-fg/15 rounded px-2 py-1 text-xs focus:border-accent">
                      {CHARSETS.map((cs) => <option key={cs} value={cs}>{cs}</option>)}
                    </select>
                    <input value={collation} onChange={(e) => setCollation(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
                      title={t("定序（可留空用預設）")}
                      className="bg-well border border-fg/15 rounded px-2 py-1 text-xs focus:border-accent w-48 mono" placeholder={t("定序（預設）")} />
                    <button type="button" onClick={convertCharset} disabled={converting}
                      className="px-3 py-1.5 text-xs rounded border border-amber-400/40 text-amber-300 hover:bg-amber-500/10 disabled:opacity-40">
                      {converting ? t("轉換中…") : t("轉換字元集")}</button>
                  </div>
                </div>
              </div>
            </Section>
          )}

          <Section title={`欄位（${cols?.length ?? 0}）`}>
            {cols == null ? <Empty text={t("載入中…")} /> : cols.length === 0 ? <Empty text={t("（無）")} /> : (
              <table className="w-full text-xs">
                <thead className="text-fg/40">
                  <tr><Th>{t("欄名")}</Th><Th>{t("型別")}</Th><Th>NULL</Th><Th>{t("鍵")}</Th><Th>{t("預設")}</Th><Th>{t("註解")}</Th></tr>
                </thead>
                <tbody>
                  {cols.map((c) => (
                    <tr key={c.name} className="border-t border-fg/5">
                      <Td mono>{c.name}</Td>
                      <Td>{c.data_type}</Td>
                      <Td>{c.nullable ? t("是") : t("否")}</Td>
                      <Td>{c.key || "—"}</Td>
                      <Td mono>{c.default ?? "—"}</Td>
                      <Td>{c.comment || "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title={`索引（${idx?.length ?? 0}）`}>
            {idx == null ? <Empty text={t("載入中…")} /> : idx.length === 0 ? <Empty text={t("（無）")} /> : (
              <table className="w-full text-xs">
                <thead className="text-fg/40">
                  <tr><Th>{t("名稱")}</Th><Th>{t("欄位")}</Th><Th>{t("唯一")}</Th><Th>{t("主鍵")}</Th></tr>
                </thead>
                <tbody>
                  {idx.map((ix) => (
                    <tr key={ix.name} className="border-t border-fg/5">
                      <Td mono>{ix.name}</Td>
                      <Td mono>{ix.columns.join(", ")}</Td>
                      <Td>{ix.unique ? t("是") : t("否")}</Td>
                      <Td>{ix.primary ? t("是") : t("否")}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-fg/10 px-3 py-2">
      <div className="text-xs text-fg/40">{label}</div>
      <div className="text-base mono text-fg/90 mt-0.5">{value}</div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-fg/45 uppercase tracking-wide mb-1.5">{title}</div>
      <div className="rounded border border-fg/10 overflow-hidden">{children}</div>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <div className="text-fg/40 text-xs px-3 py-2">{text}</div>;
}
function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-normal px-3 py-1.5">{children}</th>;
}
function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <td className={`px-3 py-1 text-fg/80 ${mono ? "mono" : ""}`}>{children}</td>;
}
