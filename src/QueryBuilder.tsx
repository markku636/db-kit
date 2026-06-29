import { useEffect, useMemo, useRef, useState } from "react";
import {
  Blocks, Table2, Plus, Trash2, X, ArrowUpDown, Filter, Wand2, Copy, Check,
  Link2, Sigma, Play, Database,
} from "lucide-react";
import { api, DbKind, ErModel, ErTable, QueryResult } from "./api";
import {
  buildSelectQuery, formatSql, isSystemDatabase,
  type QbColumn, type QbJoin, type QbCond, type QbHaving, type QbOrder, type QbAgg, type QbJoinType, type QbConj,
} from "./sql";
import { Modal, Button, Select, Input, Icon, EmptyState } from "./ui/index";
import { copyToClipboard } from "./ui";

// 視覺化查詢建構器（致敬 Navicat 的 SQL Builder）：勾選表 / 欄、視覺化 JOIN（可由外鍵自動推斷）、
// WHERE / ORDER BY / GROUP BY（聚合自動分組）、DISTINCT / LIMIT，即時產生 SELECT 並可帶入查詢編輯器。

let qbSeq = 0;
const uid = () => `qb${++qbSeq}`;

const JOIN_TYPES: QbJoinType[] = ["INNER", "LEFT", "RIGHT", "FULL"];
const OPS = ["=", "<>", ">", ">=", "<", "<=", "LIKE", "NOT LIKE", "IN", "NOT IN", "IS NULL", "IS NOT NULL"];
const AGGS: { v: QbAgg; label: string }[] = [
  { v: "", label: "（欄位）" },
  { v: "COUNT", label: "COUNT" },
  { v: "COUNT_DISTINCT", label: "COUNT DISTINCT" },
  { v: "SUM", label: "SUM" },
  { v: "AVG", label: "AVG" },
  { v: "MIN", label: "MIN" },
  { v: "MAX", label: "MAX" },
];
// FULL JOIN 在 MySQL 不支援；下拉依方言過濾。
const joinTypesFor = (kind: DbKind): QbJoinType[] =>
  kind === "mysql" ? JOIN_TYPES.filter((t) => t !== "FULL") : JOIN_TYPES;

interface SelCol extends QbColumn { id: string }
interface SelJoin extends QbJoin { id: string }
interface SelCond extends QbCond { id: string }
interface SelHaving extends QbHaving { id: string }
interface SelOrder extends QbOrder { id: string }

export default function QueryBuilder({
  connId, kind, initialDb, initialTable, onClose, onUse,
}: {
  connId: string;
  kind: DbKind;
  initialDb: string;
  initialTable?: string; // 開啟時預先加入的資料表（從側欄資料表右鍵啟動）
  onClose: () => void;
  onUse: (sql: string) => void;
}) {
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState(initialDb);
  const [model, setModel] = useState<ErModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tableFilter, setTableFilter] = useState("");

  // 已選的表（順序即 FROM / JOIN 順序，首個為基底表）。
  const [picked, setPicked] = useState<string[]>([]);
  const [cols, setCols] = useState<SelCol[]>([]);
  const [joins, setJoins] = useState<SelJoin[]>([]);
  const [conds, setConds] = useState<SelCond[]>([]);
  const [havings, setHavings] = useState<SelHaving[]>([]);
  const [orders, setOrders] = useState<SelOrder[]>([]);
  const [distinct, setDistinct] = useState(false);
  const [limit, setLimit] = useState<string>("100");
  const [offset, setOffset] = useState<string>("");
  const [copied, setCopied] = useState(false);
  // 結果預覽：在建構器內直接執行產生的查詢（套上預覽上限）看結果，免切到編輯器。
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // 載入資料庫清單
  useEffect(() => {
    api.listDatabases(connId)
      .then((d) => { setDbs(d); setDb((cur) => cur || d.find((x) => !isSystemDatabase(kind, x)) || d[0] || ""); })
      .catch((e) => setErr(e?.message ?? "讀取資料庫失敗"));
  }, [connId, kind]);

  // 載入結構（表 + 欄 + 外鍵關係）。切換 DB 會重置已選狀態。
  useEffect(() => {
    if (!db) return;
    let cancelled = false;
    setLoading(true); setErr(null);
    api.erModel(connId, db)
      .then((m) => {
        if (cancelled) return;
        setModel(m);
        setPicked([]); setCols([]); setJoins([]); setConds([]); setHavings([]); setOrders([]);
        setPreview(null); setPreviewErr(null);
      })
      .catch((e) => { if (!cancelled) { setErr(e?.message ?? "讀取結構失敗"); setModel(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connId, db]);

  // 由側欄資料表啟動時：模型載入後自動加入該表（僅一次）。
  const seeded = useRef(false);
  useEffect(() => {
    if (!model || seeded.current || !initialTable) return;
    if (model.tables.some((t) => t.name === initialTable)) {
      seeded.current = true;
      addTable(initialTable);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, initialTable]);

  const tableByName = (n: string): ErTable | undefined => model?.tables.find((t) => t.name === n);
  const colsOf = (n: string): string[] => tableByName(n)?.columns.map((c) => c.name) ?? [];

  // 在已選表之間（含與新表）尋找外鍵關係，用於自動 JOIN 推斷。
  const relationBetween = (a: string, b: string) =>
    model?.relations.find(
      (r) => (r.from_table === a && r.to_table === b) || (r.from_table === b && r.to_table === a),
    );

  // 加入一張表：附帶把它所有欄位加入 SELECT；若與既有表有外鍵則自動建 JOIN。
  function addTable(name: string) {
    if (picked.includes(name)) return;
    const isBase = picked.length === 0;
    setPicked((p) => [...p, name]);
    setCols((c) => [...c, ...colsOf(name).map((col) => ({ id: uid(), table: name, column: col, agg: "" as QbAgg }))]);
    if (!isBase) {
      // 找與任一既有表的關係，建一條 JOIN。
      for (const existing of picked) {
        const rel = relationBetween(existing, name);
        if (rel) {
          // 讓 left = 既有表、right = 新表（FROM 順序）。
          const left = rel.from_table === existing ? rel : { ...rel, from_table: rel.to_table, from_column: rel.to_column, to_table: rel.from_table, to_column: rel.from_column };
          setJoins((j) => [...j, {
            id: uid(), type: "INNER", leftTable: existing, leftCol: left.from_column,
            rightTable: name, rightCol: left.to_column,
          }]);
          break;
        }
      }
    }
  }

  // 移除一張表：連帶清掉其欄位 / JOIN / 條件 / 排序。
  function removeTable(name: string) {
    setPicked((p) => p.filter((t) => t !== name));
    setCols((c) => c.filter((x) => x.table !== name));
    setJoins((j) => j.filter((x) => x.leftTable !== name && x.rightTable !== name));
    setConds((c) => c.filter((x) => x.table !== name));
    setHavings((h) => h.filter((x) => x.table !== name));
    setOrders((o) => o.filter((x) => x.table !== name));
  }

  // 由所有已選表之間的外鍵自動補齊 JOIN（缺漏處才補）。
  function autoJoin() {
    if (!model || picked.length < 2) return;
    const next: SelJoin[] = [];
    for (let i = 1; i < picked.length; i++) {
      const right = picked[i];
      // 找與前面任一表的關係。
      let made = false;
      for (let k = 0; k < i; k++) {
        const left = picked[k];
        const rel = relationBetween(left, right);
        if (rel) {
          const r = rel.from_table === left ? rel : { ...rel, from_column: rel.to_column, to_column: rel.from_column };
          next.push({ id: uid(), type: "INNER", leftTable: left, leftCol: r.from_column, rightTable: right, rightCol: r.to_column });
          made = true;
          break;
        }
      }
      if (!made) next.push({ id: uid(), type: "INNER", leftTable: picked[0], leftCol: "", rightTable: right, rightCol: "" });
    }
    setJoins(next);
  }

  const toggleCol = (table: string, column: string) => {
    setCols((c) => {
      const exists = c.find((x) => x.table === table && x.column === column && !x.agg);
      if (exists) return c.filter((x) => x !== exists);
      return [...c, { id: uid(), table, column, agg: "" as QbAgg }];
    });
  };
  const colShown = (table: string, column: string) =>
    cols.some((x) => x.table === table && x.column === column);
  // 全選此表欄位（補入尚未顯示者，維持原有聚合 / 別名設定）。
  const selectAllCols = (table: string) => {
    setCols((c) => {
      const shown = new Set(c.filter((x) => x.table === table).map((x) => x.column));
      const add = colsOf(table)
        .filter((col) => !shown.has(col))
        .map((col) => ({ id: uid(), table, column: col, agg: "" as QbAgg }));
      return [...c, ...add];
    });
  };
  // 清空此表所選欄位。
  const clearCols = (table: string) => setCols((c) => c.filter((x) => x.table !== table));

  const spec = useMemo(() => ({
    db,
    baseTable: picked[0] ?? "",
    tables: picked.map((name) => ({ name })),
    columns: cols.map(({ table, column, agg, alias }) => ({ table, column, agg, alias })),
    joins: joins.map(({ type, leftTable, leftCol, rightTable, rightCol }) => ({ type, leftTable, leftCol, rightTable, rightCol })),
    conds: conds.map(({ table, column, op, value, conj }) => ({ table, column, op, value, conj })),
    havings: havings.map(({ agg, table, column, op, value, conj }) => ({ agg, table, column, op, value, conj })),
    orders: orders.map(({ table, column, dir }) => ({ table, column, dir })),
    distinct,
    limit: limit.trim() === "" ? null : Number(limit),
    offset: offset.trim() === "" ? null : Number(offset),
  }), [db, picked, cols, joins, conds, havings, orders, distinct, limit, offset]);

  const generated = useMemo(() => {
    const raw = buildSelectQuery(kind, spec);
    return raw ? formatSql(raw) : "";
  }, [kind, spec]);

  const availTables = useMemo(() => {
    const list = model?.tables.map((t) => t.name) ?? [];
    const f = tableFilter.trim().toLowerCase();
    return f ? list.filter((n) => n.toLowerCase().includes(f)) : list;
  }, [model, tableFilter]);

  // 所有已選表的「表.欄」候選（供條件 / 排序 / JOIN 欄位下拉）。
  const allColRefs = useMemo(
    () => picked.flatMap((t) => colsOf(t).map((c) => ({ table: t, column: c }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picked, model],
  );

  const doCopy = async () => { if (await copyToClipboard(generated)) { setCopied(true); setTimeout(() => setCopied(false), 1200); } };

  // 執行預覽：跑產生的查詢但套上預覽上限（未設 LIMIT → 200；已設 → 取 min(設定, 500)）。
  const runPreview = async () => {
    if (!spec.baseTable || previewing) return;
    const cap = spec.limit && spec.limit > 0 ? Math.min(spec.limit, 500) : 200;
    const sql = buildSelectQuery(kind, { ...spec, limit: cap });
    if (!sql) return;
    setPreviewing(true); setPreviewErr(null);
    try {
      setPreview(await api.runQuery(connId, sql));
    } catch (e: any) {
      setPreview(null);
      setPreviewErr(e?.message ?? "預覽失敗");
    } finally {
      setPreviewing(false);
    }
  };

  const dbList = dbs.filter((d) => !isSystemDatabase(kind, d));

  return (
    <Modal
      open
      onClose={onClose}
      title="視覺化查詢建構器"
      icon={Blocks}
      size="full"
      className="h-[88vh]"
      bodyClassName="p-0 flex flex-col min-h-0"
      footer={
        <>
          <span className="mr-auto text-[11px] text-fg/40">
            {picked.length ? `${picked.length} 表 · ${cols.length} 欄` : "從左側挑選資料表開始"}
          </span>
          <Button variant="ghost" onClick={onClose}>關閉</Button>
          <Button icon={copied ? Check : Copy} disabled={!generated} onClick={doCopy}>
            {copied ? "已複製" : "複製 SQL"}
          </Button>
          <Button variant="primary" icon={Play} disabled={!generated} onClick={() => { onUse(generated); onClose(); }}>
            帶入查詢編輯器
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-fg/10 shrink-0">
        <Icon icon={Database} size={14} className="text-fg/40" />
        {kind === "sqlite" ? (
          <span className="text-xs text-fg/60">{db || "（檔案資料庫）"}</span>
        ) : (
          <Select selectSize="sm" value={db} onChange={(e) => setDb(e.target.value)} className="max-w-[220px] text-xs">
            {!dbList.includes(db) && db && <option value={db}>{db}</option>}
            {dbList.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        )}
        {loading && <span className="text-xs text-fg/40">載入結構中…</span>}
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* 左：可選表清單 */}
        <div className="w-56 shrink-0 border-r border-fg/10 flex flex-col min-h-0">
          <div className="p-2 border-b border-fg/10">
            <Input inputSize="sm" placeholder="搜尋資料表…" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)} className="text-xs" />
          </div>
          <div className="flex-1 overflow-auto py-1">
            {availTables.map((n) => {
              const on = picked.includes(n);
              return (
                <button key={n} type="button" onClick={() => (on ? removeTable(n) : addTable(n))}
                  className={`flex items-center gap-1.5 w-full text-left px-3 py-1 text-xs ${on ? "text-accent font-medium" : "text-fg/70 hover:bg-fg/5"}`}>
                  <Icon icon={Table2} size={12} className={on ? "text-accent" : "text-fg/30"} />
                  <span className="truncate flex-1">{n}</span>
                  {on ? <Icon icon={Check} size={12} /> : <Icon icon={Plus} size={12} className="text-fg/30" />}
                </button>
              );
            })}
            {!availTables.length && !loading && (
              <div className="px-3 py-4 text-xs text-fg/40">{model ? "無相符資料表" : "—"}</div>
            )}
          </div>
        </div>

        {/* 中：建構面板 */}
        <div className="flex-1 min-w-0 overflow-auto p-4 space-y-4">
          {!picked.length ? (
            <EmptyState icon={Blocks} title="開始建構查詢" hint="從左側挑選一或多張資料表，勾選要顯示的欄位，加入 JOIN / 條件 / 排序，即時產生 SQL。" />
          ) : (
            <>
              {/* 已選表 + 欄位勾選 */}
              <section>
                <SectionTitle icon={Table2} text="資料表與欄位" hint="勾選要查詢的欄位（不選＝全部 *）" />
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                  {picked.map((t, i) => (
                    <div key={t} className="rounded border border-fg/10 bg-app/40">
                      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-fg/10">
                        <Icon icon={Table2} size={12} className="text-accent" />
                        <span className="text-xs font-medium truncate flex-1">{t}</span>
                        {i === 0 && <span className="text-[10px] text-fg/40 px-1 rounded bg-fg/10">基底</span>}
                        <button type="button" onClick={() => selectAllCols(t)} title="全選此表欄位" className="text-[10px] text-fg/40 hover:text-accent">全選</button>
                        <button type="button" onClick={() => clearCols(t)} title="清空此表欄位" className="text-[10px] text-fg/40 hover:text-accent">清空</button>
                        <button type="button" onClick={() => removeTable(t)} className="text-fg/30 hover:text-red-400" title="移除此表"><Icon icon={X} size={13} /></button>
                      </div>
                      <div className="max-h-44 overflow-auto py-1">
                        {tableByName(t)?.columns.map((c) => (
                          <label key={c.name} className="flex items-center gap-1.5 px-2 py-0.5 text-xs hover:bg-fg/5 cursor-pointer">
                            <input type="checkbox" checked={colShown(t, c.name)} onChange={() => toggleCol(t, c.name)} className="accent-[rgb(var(--c-accent))]" />
                            <span className={`truncate flex-1 ${c.pk ? "text-amber-300" : ""}`}>{c.name}</span>
                            {c.pk && <span className="text-[9px] text-amber-300/70">PK</span>}
                            {c.fk && <Icon icon={Link2} size={10} className="text-sky-400/70" />}
                            <span className="text-[10px] text-fg/30 truncate max-w-[80px]">{c.data_type}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* JOIN */}
              {picked.length > 1 && (
                <section>
                  <SectionTitle icon={Link2} text="連接（JOIN）"
                    action={<button type="button" onClick={autoJoin} className="text-[11px] text-accent hover:underline inline-flex items-center gap-1"><Icon icon={Wand2} size={11} />由外鍵自動連接</button>} />
                  <div className="space-y-1.5">
                    {joins.map((j) => (
                      <div key={j.id} className="flex items-center gap-1.5 text-xs flex-wrap">
                        <Select selectSize="sm" value={j.type} onChange={(e) => setJoins((js) => js.map((x) => x.id === j.id ? { ...x, type: e.target.value as QbJoinType } : x))} className="text-xs w-20">
                          {joinTypesFor(kind).map((t) => <option key={t} value={t}>{t}</option>)}
                        </Select>
                        <ColPicker tables={picked} colsOf={colsOf} table={j.leftTable} column={j.leftCol}
                          onChange={(table, column) => setJoins((js) => js.map((x) => x.id === j.id ? { ...x, leftTable: table, leftCol: column } : x))} />
                        <span className="text-fg/40">=</span>
                        <ColPicker tables={picked} colsOf={colsOf} table={j.rightTable} column={j.rightCol}
                          onChange={(table, column) => setJoins((js) => js.map((x) => x.id === j.id ? { ...x, rightTable: table, rightCol: column } : x))} />
                        <button type="button" onClick={() => setJoins((js) => js.filter((x) => x.id !== j.id))} className="text-fg/30 hover:text-red-400"><Icon icon={Trash2} size={13} /></button>
                      </div>
                    ))}
                    <button type="button" onClick={() => setJoins((js) => [...js, { id: uid(), type: "INNER", leftTable: picked[0], leftCol: "", rightTable: picked[1] ?? picked[0], rightCol: "" }])}
                      className="text-[11px] text-fg/50 hover:text-fg inline-flex items-center gap-1"><Icon icon={Plus} size={11} />新增連接</button>
                  </div>
                </section>
              )}

              {/* WHERE */}
              <section>
                <SectionTitle icon={Filter} text="篩選條件（WHERE）" />
                <div className="space-y-1.5">
                  {conds.map((c, i) => (
                    <div key={c.id} className="flex items-center gap-1.5 text-xs flex-wrap">
                      {i === 0 ? <span className="w-12 text-fg/40 text-[11px]">WHERE</span> : (
                        <Select selectSize="sm" value={c.conj ?? "AND"} onChange={(e) => setConds((cs) => cs.map((x) => x.id === c.id ? { ...x, conj: e.target.value as QbConj } : x))} className="text-xs w-12">
                          <option value="AND">AND</option><option value="OR">OR</option>
                        </Select>
                      )}
                      <ColPicker tables={picked} colsOf={colsOf} table={c.table} column={c.column}
                        onChange={(table, column) => setConds((cs) => cs.map((x) => x.id === c.id ? { ...x, table, column } : x))} />
                      <Select selectSize="sm" value={c.op} onChange={(e) => setConds((cs) => cs.map((x) => x.id === c.id ? { ...x, op: e.target.value } : x))} className="text-xs w-24">
                        {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                      </Select>
                      {c.op !== "IS NULL" && c.op !== "IS NOT NULL" && (
                        <Input inputSize="sm" value={c.value ?? ""} placeholder={c.op === "IN" || c.op === "NOT IN" ? "值,值,值" : "值"}
                          onChange={(e) => setConds((cs) => cs.map((x) => x.id === c.id ? { ...x, value: e.target.value } : x))} className="text-xs w-40" />
                      )}
                      <button type="button" onClick={() => setConds((cs) => cs.filter((x) => x.id !== c.id))} className="text-fg/30 hover:text-red-400"><Icon icon={Trash2} size={13} /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setConds((cs) => [...cs, { id: uid(), table: picked[0], column: colsOf(picked[0])[0] ?? "", op: "=", value: "", conj: "AND" }])}
                    className="text-[11px] text-fg/50 hover:text-fg inline-flex items-center gap-1"><Icon icon={Plus} size={11} />新增條件</button>
                </div>
              </section>

              {/* GROUP BY 提示（自動）+ 聚合 */}
              <section>
                <SectionTitle icon={Sigma} text="聚合 / 分組（GROUP BY）" hint="把欄位設成聚合函式即自動以其餘欄位分組" />
                <div className="space-y-1">
                  {cols.length === 0 && <div className="text-[11px] text-fg/40">未選欄位，無法設定聚合。</div>}
                  {cols.map((c) => (
                    <div key={c.id} className="flex items-center gap-1.5 text-xs">
                      <span className="mono text-fg/60 truncate w-48">{c.table}.{c.column}</span>
                      <Select selectSize="sm" value={c.agg ?? ""} onChange={(e) => setCols((cs) => cs.map((x) => x.id === c.id ? { ...x, agg: e.target.value as QbAgg } : x))} className="text-xs w-36">
                        {AGGS.map((a) => <option key={a.v} value={a.v}>{a.label}</option>)}
                      </Select>
                      <Input inputSize="sm" value={c.alias ?? ""} placeholder="別名（可空）"
                        onChange={(e) => setCols((cs) => cs.map((x) => x.id === c.id ? { ...x, alias: e.target.value } : x))} className="text-xs w-32" />
                    </div>
                  ))}
                </div>
              </section>

              {/* HAVING（群組後篩選） */}
              <section>
                <SectionTitle icon={Filter} text="群組後篩選（HAVING）" hint="以聚合結果篩選分組，如 COUNT(id) > 1" />
                <div className="space-y-1.5">
                  {havings.map((h, i) => (
                    <div key={h.id} className="flex items-center gap-1.5 text-xs flex-wrap">
                      {i === 0 ? <span className="w-12 text-fg/40 text-[11px]">HAVING</span> : (
                        <Select selectSize="sm" value={h.conj ?? "AND"} onChange={(e) => setHavings((hs) => hs.map((x) => x.id === h.id ? { ...x, conj: e.target.value as QbConj } : x))} className="text-xs w-12">
                          <option value="AND">AND</option><option value="OR">OR</option>
                        </Select>
                      )}
                      <Select selectSize="sm" value={h.agg ?? ""} onChange={(e) => setHavings((hs) => hs.map((x) => x.id === h.id ? { ...x, agg: e.target.value as QbAgg } : x))} className="text-xs w-32">
                        {AGGS.map((a) => <option key={a.v} value={a.v}>{a.label}</option>)}
                      </Select>
                      <ColPicker tables={picked} colsOf={colsOf} table={h.table} column={h.column}
                        onChange={(table, column) => setHavings((hs) => hs.map((x) => x.id === h.id ? { ...x, table, column } : x))} />
                      <Select selectSize="sm" value={h.op} onChange={(e) => setHavings((hs) => hs.map((x) => x.id === h.id ? { ...x, op: e.target.value } : x))} className="text-xs w-24">
                        {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                      </Select>
                      {h.op !== "IS NULL" && h.op !== "IS NOT NULL" && (
                        <Input inputSize="sm" value={h.value ?? ""} placeholder="值"
                          onChange={(e) => setHavings((hs) => hs.map((x) => x.id === h.id ? { ...x, value: e.target.value } : x))} className="text-xs w-32" />
                      )}
                      <button type="button" onClick={() => setHavings((hs) => hs.filter((x) => x.id !== h.id))} className="text-fg/30 hover:text-red-400"><Icon icon={Trash2} size={13} /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setHavings((hs) => [...hs, { id: uid(), agg: "COUNT", table: picked[0], column: colsOf(picked[0])[0] ?? "", op: ">", value: "", conj: "AND" }])}
                    className="text-[11px] text-fg/50 hover:text-fg inline-flex items-center gap-1"><Icon icon={Plus} size={11} />新增 HAVING 條件</button>
                </div>
              </section>

              {/* ORDER BY */}
              <section>
                <SectionTitle icon={ArrowUpDown} text="排序（ORDER BY）" />
                <div className="space-y-1.5">
                  {orders.map((o) => (
                    <div key={o.id} className="flex items-center gap-1.5 text-xs">
                      <ColPicker tables={picked} colsOf={colsOf} table={o.table} column={o.column}
                        onChange={(table, column) => setOrders((os) => os.map((x) => x.id === o.id ? { ...x, table, column } : x))} />
                      <Select selectSize="sm" value={o.dir} onChange={(e) => setOrders((os) => os.map((x) => x.id === o.id ? { ...x, dir: e.target.value as "ASC" | "DESC" } : x))} className="text-xs w-24">
                        <option value="ASC">ASC ↑</option><option value="DESC">DESC ↓</option>
                      </Select>
                      <button type="button" onClick={() => setOrders((os) => os.filter((x) => x.id !== o.id))} className="text-fg/30 hover:text-red-400"><Icon icon={Trash2} size={13} /></button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setOrders((os) => [...os, { id: uid(), table: picked[0], column: colsOf(picked[0])[0] ?? "", dir: "ASC" }])}
                    className="text-[11px] text-fg/50 hover:text-fg inline-flex items-center gap-1"><Icon icon={Plus} size={11} />新增排序</button>
                </div>
              </section>

              {/* 選項 */}
              <section className="flex items-center gap-4 text-xs">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={distinct} onChange={(e) => setDistinct(e.target.checked)} className="accent-[rgb(var(--c-accent))]" />
                  DISTINCT（去重）
                </label>
                <label className="inline-flex items-center gap-1.5">
                  LIMIT
                  <Input inputSize="sm" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ""))} className="text-xs w-20" placeholder="無" />
                </label>
                <label className="inline-flex items-center gap-1.5">
                  OFFSET
                  <Input inputSize="sm" value={offset} onChange={(e) => setOffset(e.target.value.replace(/[^\d]/g, ""))} className="text-xs w-20" placeholder="0" />
                </label>
                {allColRefs.length === 0 && null}
              </section>
            </>
          )}
        </div>

        {/* 右：SQL 預覽 + 執行結果預覽 */}
        <div className="w-80 shrink-0 border-l border-fg/10 flex flex-col min-h-0">
          <div className="px-3 py-1.5 border-b border-fg/10 text-[11px] text-fg/40 flex items-center gap-1.5">
            <Icon icon={Wand2} size={12} />產生的 SQL
            <button type="button" onClick={runPreview} disabled={!generated || previewing}
              title="在建構器內執行查詢看結果（套上預覽上限）"
              className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-fg/15 hover:bg-fg/10 text-fg/70 disabled:opacity-40">
              <Icon icon={Play} size={11} />{previewing ? "預覽中…" : "預覽"}
            </button>
          </div>
          <pre className="flex-1 overflow-auto p-3 text-xs mono text-fg/80 whitespace-pre-wrap break-words min-h-[80px]">
            {generated || "—"}
          </pre>
          {(preview || previewErr) && (
            <div className="border-t border-fg/10 flex flex-col min-h-0 max-h-[45%]">
              <div className="px-3 py-1 text-[11px] text-fg/40 border-b border-fg/10 shrink-0">
                {previewErr ? <span className="text-red-400">預覽錯誤</span> : `預覽結果 · ${preview?.rows.length ?? 0} 列`}
              </div>
              <div className="overflow-auto">
                {previewErr ? (
                  <div className="p-2 text-xs text-red-300 whitespace-pre-wrap break-words">{previewErr}</div>
                ) : preview && preview.columns.length > 0 ? (
                  <table className="text-[11px] border-collapse w-full">
                    <thead>
                      <tr className="text-left text-fg/40">
                        {preview.columns.map((c, i) => <th key={i} className="px-2 py-1 font-medium border-b border-fg/10 whitespace-nowrap">{c}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, ri) => (
                        <tr key={ri} className="border-b border-fg/5">
                          {row.map((v, ci) => (
                            <td key={ci} className="px-2 py-0.5 mono text-fg/70 max-w-[140px] truncate" title={v ?? "NULL"}>
                              {v === null ? <span className="text-fg/25 italic">NULL</span> : v}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="p-2 text-xs text-fg/40">（無結果）</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SectionTitle({ icon, text, hint, action }: { icon: typeof Table2; text: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <Icon icon={icon} size={13} className="text-fg/40" />
      <span className="text-xs font-medium text-fg/80">{text}</span>
      {hint && <span className="text-[10px] text-fg/35">{hint}</span>}
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
}

// 「表.欄」二段下拉：先選表（限已選表），再選該表欄位。
function ColPicker({ tables, colsOf, table, column, onChange }: {
  tables: string[];
  colsOf: (t: string) => string[];
  table: string;
  column: string;
  onChange: (table: string, column: string) => void;
}) {
  return (
    <>
      <Select selectSize="sm" value={table} onChange={(e) => { const t = e.target.value; onChange(t, colsOf(t)[0] ?? ""); }} className="text-xs w-28">
        {tables.map((t) => <option key={t} value={t}>{t}</option>)}
      </Select>
      <span className="text-fg/30">.</span>
      <Select selectSize="sm" value={column} onChange={(e) => onChange(table, e.target.value)} className="text-xs w-32">
        {!colsOf(table).includes(column) && column && <option value={column}>{column}</option>}
        {colsOf(table).map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
    </>
  );
}
