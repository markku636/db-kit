import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Wand2 } from "lucide-react";
import { api, ColumnInfo, DbKind } from "./api";
import { toast } from "./ui";
import { Modal, Button } from "./ui/index";
import Icon from "./ui/Icon";
import { buildInsertValues } from "./sql";

// ---- 純值合成輔助（不依賴 React state，抽到模組層以降低 synth 複雜度）----
const rint = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const pad2 = (n: number) => String(n).padStart(2, "0");
const randStr = (n: number) => {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let k = 0; k < n; k++) s += chars[rint(0, chars.length - 1)];
  return s;
};
const INT_TYPES = new Set(["int", "integer", "tinyint", "smallint", "mediumint", "bigint", "serial", "bigserial", "smallserial"]);
const DEC_TYPES = new Set(["decimal", "numeric", "float", "double", "real", "money"]);
// 整數上限 [signed, unsigned]，避免 tinyint(127)/smallint(32767) 溢位；其餘用通用 100000。
const INT_BOUND: Record<string, [number, number]> = {
  tinyint: [100, 200], smallint: [30000, 60000], smallserial: [30000, 60000], mediumint: [8000000, 8000000],
};
const synthInt = (kind: string, unsigned: boolean) => {
  const b = INT_BOUND[kind];
  if (!b) return String(rint(1, 100000));
  return String(rint(1, b[unsigned ? 1 : 0]));
};
// 小數：MySQL 的 decimal(p,s) 精度寫進 data_type，依精度 / 小數位產生避免溢位；
// PG 的 numeric 精度不在 data_type，退回保守小值（≤ 99.99）以容納窄精度欄位。
const synthDecimal = (dataType: string, kind: string) => {
  const m = /\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\)/.exec(dataType);
  if ((kind === "decimal" || kind === "numeric") && m) {
    const precision = Number.parseInt(m[1], 10);
    const scale = m[2] == null ? 0 : Number.parseInt(m[2], 10);
    const intPart = rint(0, Math.pow(10, Math.min(Math.max(1, precision - scale), 12)) - 1);
    if (scale <= 0) return String(intPart);
    const frac = rint(0, Math.pow(10, Math.min(scale, 6)) - 1);
    return `${intPart}.${String(frac).padStart(scale, "0")}`;
  }
  return (rint(0, 9999) / 100).toFixed(2);
};

// 資料產生：依欄位型別 / 欄名啟發式合成測試資料，產生 INSERT 語句送往查詢編輯器（不直接執行，供檢視後執行）。
// 對標 Navicat「資料產生」。值一律以字串字面值輸出，依賴資料庫對欄位型別的隱式轉換（MySQL / PG / SQLite 皆可）。
export default function DataGenerator({ connId, db, table, kind, onClose, onGenerate }: {
  connId: string;
  db: string;
  table: string;
  kind: DbKind;
  onClose: () => void;
  onGenerate: (sql: string) => void;
}) {
  const [cols, setCols] = useState<ColumnInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState(50);
  // 每欄是否納入產生（auto_increment / generated / serial 預設排除，交由 DB 自帶值）。
  const [include, setInclude] = useState<Record<string, boolean>>({});

  // 偵測欄位是否應預設排除（自增 / 產生欄 / PG serial nextval 預設 / SQLite 單欄 INTEGER 主鍵 rowid）。
  // PostgreSQL 的 GENERATED ALWAYS / GENERATED ALWAYS AS IDENTITY 欄位由後端在 extra 標上含
  // "generated" 的描述，故下方的 ex.includes("generated") 會一併把它們預設排除（不可明確賦值）。
  const isAuto = (c: ColumnInfo, pkCount: number) => {
    const ex = (c.extra ?? "").toLowerCase();
    const def = (c.default ?? "").toLowerCase();
    const sqlitePk = kind === "sqlite" && c.key === "PRI" && pkCount === 1 && /int/i.test(c.data_type);
    return sqlitePk || ex.includes("auto_increment") || ex.includes("generated") || ex.includes("virtual") || ex.includes("stored") || def.includes("nextval");
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.tableColumns(connId, db, table)
      .then((c) => {
        if (cancelled) return;
        setCols(c);
        const pkCount = c.filter((x) => x.key === "PRI").length;
        const inc: Record<string, boolean> = {};
        for (const col of c) inc[col.name] = !isAuto(col, pkCount);
        setInclude(inc);
      })
      .catch((e) => { if (!cancelled) setErr(e?.message ?? "讀取欄位失敗"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connId, db, table]);

  // 由 data_type 推得基礎型別：去括號、去 MySQL 的 unsigned/zerofill 後綴，並把 PostgreSQL
  // information_schema 的 SQL 標準長名（無括號）正規化為通用短名，否則 PG 型別永遠落到字串預設分支。
  const baseType = (dt: string) => {
    const trimmed = dt.toLowerCase().replace(/\(.*$/, "").replace(/\s+(unsigned|zerofill)\b/g, "").trim();
    if (trimmed.startsWith("timestamp")) return "timestamp";       // timestamp without/with time zone
    if (trimmed === "time" || trimmed.startsWith("time ")) return "time"; // time without/with time zone
    if (trimmed === "double precision") return "double";
    if (trimmed === "character varying") return "varchar";
    if (trimmed === "character") return "char";
    return trimmed;
  };
  // MySQL / SQLite 會把長度寫進 data_type（如 varchar(50)）；PostgreSQL 不會（長度在 information_schema
  // 的 character_maximum_length，後端未帶出），故 PG 字串以保守預設長度裁切。
  const lenOf = (dt: string) => {
    const m = dt.match(/\((\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };
  const strategyLabel = (c: ColumnInfo): string => {
    const val = baseType(c.data_type);
    const dt = c.data_type.toLowerCase();
    if (dt.startsWith("tinyint(1)") || val === "bool" || val === "boolean") return "布林 0/1";
    if (INT_TYPES.has(val)) return "整數";
    if (DEC_TYPES.has(val)) return "小數";
    if (val === "date") return "日期";
    if (val === "datetime" || val === "timestamp" || val === "timestamptz") return "日期時間";
    if (val === "time") return "時間";
    if (val === "year") return "年份";
    if (val === "uuid") return "UUID";
    if (val === "json" || val === "jsonb") return "JSON {}";
    if (/email/i.test(c.name)) return "Email";
    if (/(^|_)(name|fullname)/i.test(c.name)) return "姓名";
    if (/(phone|tel|mobile)/i.test(c.name)) return "電話";
    return "字串";
  };

  // 合成單一值（回傳字串；NULL 不在此處理）。i 為列序，供部分策略產生較分散的值。
  const synth = (c: ColumnInfo, i: number): string => {
    const val = baseType(c.data_type);
    const dt = c.data_type.toLowerCase();
    // 未知長度（PG varchar）保守截到 20，避免超出 varchar(n)；已知長度則依宣告裁切。
    const cap = (s: string) => s.slice(0, lenOf(c.data_type) || 20);
    if (dt.startsWith("tinyint(1)") || val === "bool" || val === "boolean") return Math.random() < 0.5 ? "1" : "0";
    if (INT_TYPES.has(val)) return synthInt(val, dt.includes("unsigned"));
    if (DEC_TYPES.has(val)) return synthDecimal(c.data_type, val);
    if (val === "date") return `${rint(2000, 2024)}-${pad2(rint(1, 12))}-${pad2(rint(1, 28))}`;
    if (val === "datetime" || val === "timestamp" || val === "timestamptz")
      return `${rint(2000, 2024)}-${pad2(rint(1, 12))}-${pad2(rint(1, 28))} ${pad2(rint(0, 23))}:${pad2(rint(0, 59))}:${pad2(rint(0, 59))}`;
    if (val === "time") return `${pad2(rint(0, 23))}:${pad2(rint(0, 59))}:${pad2(rint(0, 59))}`;
    if (val === "year") return String(rint(1980, 2024));
    if (val === "uuid") return crypto.randomUUID();
    if (val === "json" || val === "jsonb") return "{}";
    if (/email/i.test(c.name)) return cap(`user${i}_${randStr(4).toLowerCase()}@example.com`);
    if (/(^|_)(name|fullname)/i.test(c.name)) return cap(`Name ${randStr(5)}`);
    if (/(phone|tel|mobile)/i.test(c.name)) return `09${String(rint(0, 99999999)).padStart(8, "0")}`;
    return cap(`${c.name}_${randStr(6)}`);
  };

  const pkCount = useMemo(() => cols.filter((c) => c.key === "PRI").length, [cols]);
  const included = useMemo(() => cols.filter((c) => include[c.name]), [cols, include]);
  // 被排除但 NOT NULL、無預設、且非自增的欄位：產生的 INSERT 不含它 → 執行時必違反 NOT NULL，預先提示。
  const droppedRequired = useMemo(
    () => cols.filter((c) => !include[c.name] && !c.nullable && !(c.default != null && c.default !== "") && !isAuto(c, pkCount)),
    [cols, include, pkCount], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const generate = () => {
    if (included.length === 0) { toast.error("請至少選一個欄位"); return; }
    const n = Math.max(1, Math.min(10000, rowCount || 1));
    const names = included.map((c) => c.name);
    const rows: (string | null)[][] = [];
    for (let i = 0; i < n; i++) {
      rows.push(included.map((c) => (c.nullable && Math.random() < 0.1 ? null : synth(c, i))));
    }
    const sql = `-- 資料產生：${included.length} 欄 × ${n} 列（請檢視後執行）\n` +
      buildInsertValues(kind, db, table, names, rows) + "\n";
    onGenerate(sql);
  };

  return (
    <Modal
      onClose={onClose}
      title={<span className="flex items-center gap-2"><span>資料產生</span><span className="text-xs text-fg/40 mono">{kind === "sqlite" ? table : `${db}.${table}`}</span></span>}
      icon={Wand2}
      size="md"
      zClass="z-[95]"
      bodyClassName="p-0 flex flex-col overflow-hidden"
      footer={<>
        <span className="text-fg/40 text-xs mr-auto">已選 {included.length} / {cols.length} 欄</span>
        <Button variant="secondary" onClick={onClose}>取消</Button>
        <Button variant="primary" onClick={generate} disabled={loading || !!err || included.length === 0}>產生到查詢編輯器</Button>
      </>}
    >
      <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3 text-sm">
        <span className="text-fg/45 text-xs">產生列數</span>
        <input type="number" min={1} max={10000} value={rowCount} aria-label="產生列數"
          onChange={(e) => setRowCount(parseInt(e.target.value, 10) || 0)}
          className="bg-well border border-fg/15 rounded px-2 py-1 text-xs w-24 mono outline-none focus:border-accent" />
        <span className="text-fg/30 text-xs ml-auto">值依型別 / 欄名合成，可空欄約 10% 為 NULL</span>
      </div>
      <div className="flex-1 overflow-auto p-3 text-xs">
        {loading && <div className="text-fg/40 p-2">讀取中…</div>}
        {err && <div className="text-red-400 mono p-2">{err}</div>}
        {!loading && !err && cols.map((c) => (
          <label key={c.name} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-fg/5 cursor-pointer">
            <input type="checkbox" checked={!!include[c.name]}
              onChange={(e) => setInclude((s) => ({ ...s, [c.name]: e.target.checked }))} />
            <span className="mono flex-1 truncate">{c.name}</span>
            <span className="text-fg/30 mono truncate max-w-[120px]">{c.data_type}</span>
            <span className="text-blue-300/70 w-20 text-right">{strategyLabel(c)}</span>
          </label>
        ))}
      </div>
      {droppedRequired.length > 0 && (
        <div className="px-5 py-2 border-t border-fg/10 text-amber-300/80 text-xs inline-flex items-center gap-1.5">
          <Icon icon={AlertTriangle} size={14} /> 已排除 {droppedRequired.length} 個必填欄位（NOT NULL 且無預設）：{droppedRequired.map((c) => c.name).join("、")} — 執行時會違反 NOT NULL 約束。
        </div>
      )}
    </Modal>
  );
}
