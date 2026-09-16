import { useMemo, useState } from "react";
import type { ColumnInfo, IndexInfo, ForeignKeyDef, TableDiff, TextChange } from "./api";
import { Segmented } from "./ui/index";
import { diffLines } from "./diff";
import { normalizeDdl, pairSideBySide, type SchemaStatus } from "./compareModel";
import { useT } from "./i18n";

// 單一物件的結構差異：屬性層級（欄位 / 索引 / 外鍵，新增綠 / 刪除紅 / 變更琥珀）
// 與「並排 DDL 文字 diff」兩種檢視；視圖 / 程序只有文字 diff。
export default function SchemaDiffView({ diff, status, text, srcDdl, dstDdl, srcLabel, dstLabel }: {
  diff?: TableDiff | null;
  status?: SchemaStatus;
  text?: TextChange | null;
  srcDdl?: string | null;
  dstDdl?: string | null;
  srcLabel: string;
  dstLabel: string;
}) {
  const t = useT();
  const hasAttrs = !!diff;
  const [view, setView] = useState<"attrs" | "ddl">(hasAttrs ? "attrs" : "ddl");
  const left = text ? text.src ?? "" : srcDdl ?? "";
  const right = text ? text.dst ?? "" : dstDdl ?? "";
  const pairs = useMemo(() => pairSideBySide(diffLines(normalizeDdl(left), normalizeDdl(right))), [left, right]);
  const canDdl = !!(left || right);

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        {hasAttrs && canDdl && (
          <Segmented size="sm" ariaLabel={t("檢視")} value={view} onChange={setView}
            options={[{ value: "attrs", label: t("屬性") }, { value: "ddl", label: "DDL" }]} />
        )}
        {status === "source_only" && <span className="text-green-300">{t("僅來源有（目標需新增）")}</span>}
        {status === "target_only" && <span className="text-red-300">{t("僅目標有（來源缺少）")}</span>}
        {status === "identical" && <span className="text-fg/40">{t("結構相同")}</span>}
      </div>
      {view === "attrs" && diff && <Attrs diff={diff} />}
      {(view === "ddl" || !hasAttrs) && canDdl && (
        <div className="rounded border border-fg/10 overflow-hidden">
          <div className="grid grid-cols-2 text-[11px] text-fg/50 border-b border-fg/10 bg-inset">
            <div className="px-2 py-1 truncate">{srcLabel}</div>
            <div className="px-2 py-1 truncate border-l border-fg/10">{dstLabel}</div>
          </div>
          <div className="max-h-[50vh] overflow-auto mono code-scale leading-tight">
            {pairs.map((p, i) => (
              <div key={i} className="grid grid-cols-2">
                <Cell line={p.left} side="del" />
                <Cell line={p.right} side="add" />
              </div>
            ))}
          </div>
        </div>
      )}
      {!hasAttrs && !canDdl && <div className="text-fg/40">{t("無可顯示的定義。")}</div>}
    </div>
  );
}

function Cell({ line, side }: { line: { type: string; text: string } | null; side: "del" | "add" }) {
  const cls = !line
    ? "bg-fg/[0.03]"
    : line.type === "same"
      ? "text-fg/60"
      : side === "del"
        ? "bg-red-500/10 text-red-300/90"
        : "bg-emerald-500/10 text-emerald-300/90";
  return (
    <div className={`px-2 whitespace-pre-wrap break-all ${cls} ${side === "add" ? "border-l border-fg/10" : ""}`}>
      {line ? line.text || " " : " "}
    </div>
  );
}

const colSpec = (c: ColumnInfo) =>
  `${c.data_type}${c.nullable ? "" : " NOT NULL"}${c.default != null && c.default !== "" ? ` DEFAULT ${c.default}` : ""}${c.extra ? ` ${c.extra}` : ""}${c.comment ? ` -- ${c.comment}` : ""}`;
const idxSpec = (i: IndexInfo) => `${i.primary ? "PRIMARY " : i.unique ? "UNIQUE " : ""}(${i.columns.join(", ")})`;
const fkSpec = (f: ForeignKeyDef) => `(${f.columns.join(", ")}) → ${f.ref_table}(${f.ref_columns.join(", ")})`;

function Attrs({ diff }: { diff: TableDiff }) {
  const t = useT();
  const Section = ({ title, children }: { title: string; children: React.ReactNode[] }) =>
    children.length ? (
      <div>
        <div className="text-fg/45 mb-1">{title}</div>
        <div className="space-y-0.5">{children}</div>
      </div>
    ) : null;
  const Row = ({ tone, name, a, b }: { tone: "add" | "del" | "chg"; name: string; a?: string; b?: string }) => (
    <div className={`grid grid-cols-[1.25rem_minmax(8rem,auto)_1fr] gap-x-2 px-2 py-0.5 rounded border ${
      tone === "add" ? "border-green-500/30 bg-green-500/5" : tone === "del" ? "border-red-500/30 bg-red-500/5" : "border-amber-500/30 bg-amber-500/5"}`}>
      <span className={tone === "add" ? "text-green-300" : tone === "del" ? "text-red-300" : "text-amber-300"}>{tone === "add" ? "＋" : tone === "del" ? "－" : "～"}</span>
      <span className="mono text-fg/85 truncate">{name}</span>
      <span className="mono text-fg/60 break-all">
        {tone === "chg" ? (<><span className="text-fg/80">{a}</span><span className="text-fg/35"> → </span><span className="text-fg/80">{b}</span></>) : (a ?? b)}
      </span>
    </div>
  );
  const changedAttrs = (attrs: string[]) => attrs.map((a) => t(({ data_type: "型別", nullable: "可空", default: "預設值", extra: "額外", comment: "註解" } as Record<string, string>)[a] ?? a)).join("、");
  return (
    <div className="space-y-3">
      <Section title={t("欄位")}>
        {[
          ...diff.columns_added.map((c) => <Row key={`a${c.name}`} tone="add" name={c.name} a={colSpec(c)} />),
          ...diff.columns_removed.map((c) => <Row key={`r${c.name}`} tone="del" name={c.name} b={colSpec(c)} />),
          ...diff.columns_changed.map((c) => <Row key={`c${c.name}`} tone="chg" name={`${c.name}（${changedAttrs(c.attrs)}）`} a={colSpec(c.src)} b={colSpec(c.dst)} />),
        ]}
      </Section>
      <Section title={t("索引")}>
        {[
          ...diff.indexes_added.map((i) => <Row key={`a${i.name}`} tone="add" name={i.name} a={idxSpec(i)} />),
          ...diff.indexes_removed.map((i) => <Row key={`r${i.name}`} tone="del" name={i.name} b={idxSpec(i)} />),
          ...diff.indexes_changed.map((i) => <Row key={`c${i.name}`} tone="chg" name={i.renamed ? t("{a} → {b}（改名）", { a: i.src.name, b: i.dst.name }) : i.name} a={idxSpec(i.src)} b={idxSpec(i.dst)} />),
        ]}
      </Section>
      <Section title={t("外鍵")}>
        {[
          ...diff.fks_added.map((f) => <Row key={`a${f.name}`} tone="add" name={f.name} a={fkSpec(f)} />),
          ...diff.fks_removed.map((f) => <Row key={`r${f.name}`} tone="del" name={f.name} b={fkSpec(f)} />),
          ...diff.fks_changed.map((f) => <Row key={`c${f.name}`} tone="chg" name={f.renamed ? t("{a} → {b}（改名）", { a: f.src.name, b: f.dst.name }) : f.name} a={fkSpec(f.src)} b={fkSpec(f.dst)} />),
        ]}
      </Section>
      {diff.ddl_differs && diff.columns_added.length + diff.columns_removed.length + diff.columns_changed.length + diff.indexes_added.length + diff.indexes_removed.length + diff.indexes_changed.length + diff.fks_added.length + diff.fks_removed.length + diff.fks_changed.length === 0 && (
        <div className="text-amber-300/80">{t("欄位 / 索引 / 外鍵皆相同，但 DDL 文字不同（charset / engine / 註解等），請切到 DDL 檢視。")}</div>
      )}
    </div>
  );
}
