import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, FoldVertical, UnfoldVertical } from "lucide-react";
import type { ColumnInfo, IndexInfo, ForeignKeyDef, TableDiff, TextChange } from "./api";
import { IconButton, Segmented } from "./ui/index";
import { diffLines, diffTokens, tokenSimilarity, type DiffToken } from "./diff";
import {
  foldUnchanged, hunkStarts, normalizeDdl, numberPairs, pairSideBySide, type NumberedPair, type SchemaStatus,
} from "./compareModel";
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
  const pairs = useMemo(() => numberPairs(pairSideBySide(diffLines(normalizeDdl(left), normalizeDdl(right)))), [left, right]);
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
      {(view === "ddl" || !hasAttrs) && canDdl && <SideBySide pairs={pairs} srcLabel={srcLabel} dstLabel={dstLabel} />}
      {!hasAttrs && !canDdl && <div className="text-fg/40">{t("無可顯示的定義。")}</div>}
    </div>
  );
}

const CONTEXT_LINES = 3;
/** 相同 token 佔比低於此值＝整行重寫，字詞級標示只會變成紅綠碎片，退回整行上色。 */
const WORD_DIFF_MIN_SIMILARITY = 0.4;

/**
 * 並排文字 diff（對標 Beyond Compare / DataGrip 的檢視器）：
 * 兩側行號、字詞級標示、「只看差異」摺疊相同行（可逐段展開）、上一處 / 下一處差異導覽。
 */
export function SideBySide({ pairs, srcLabel, dstLabel }: { pairs: NumberedPair[]; srcLabel: string; dstLabel: string }) {
  const t = useT();
  const hunks = useMemo(() => hunkStarts(pairs), [pairs]);
  // 每一列屬於第幾段差異（導覽時整段一起打亮）。
  const hunkOf = useMemo(() => {
    const m = new Map<number, number>();
    hunks.forEach((start, h) => { for (let i = start; i < pairs.length && pairs[i].changed; i++) m.set(i, h); });
    return m;
  }, [hunks, pairs]);
  const [foldOn, setFoldOn] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [cur, setCur] = useState(0);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => { setCur(0); setExpanded(new Set()); }, [pairs]);

  const items = useMemo(
    () => (foldOn ? foldUnchanged(pairs, CONTEXT_LINES, expanded) : pairs.map((_, index) => ({ kind: "row" as const, index }))),
    [pairs, foldOn, expanded],
  );
  const adds = useMemo(() => pairs.filter((p) => p.right?.type === "add").length, [pairs]);
  const dels = useMemo(() => pairs.filter((p) => p.left?.type === "del").length, [pairs]);

  const go = (delta: number) => {
    const n = hunks.length;
    if (!n) return;
    const k = (((cur + delta) % n) + n) % n;
    setCur(k);
    requestAnimationFrame(() => rowRefs.current.get(hunks[k])?.scrollIntoView({ block: "center" }));
  };

  // 兩側都有、且都變了的一列 → 字詞級 diff；只有一側有（純增 / 純刪）就整行上色。
  const words = (p: NumberedPair): { l: DiffToken[]; r: DiffToken[] } | null => {
    if (!p.changed || !p.left || !p.right) return null;
    const toks = diffTokens(p.left.text, p.right.text);
    if (tokenSimilarity(toks) < WORD_DIFF_MIN_SIMILARITY) return null;
    return { l: toks.filter((x) => x.type !== "add"), r: toks.filter((x) => x.type !== "del") };
  };

  return (
    <div className="rounded border border-fg/10 overflow-hidden" data-side-by-side>
      <div className="flex items-center gap-2 px-2 py-1 text-[11px] border-b border-fg/10 bg-inset">
        <span className="mono tabular-nums text-emerald-300">+{adds}</span>
        <span className="mono tabular-nums text-red-300">−{dels}</span>
        <span className="text-fg/45">{t("{n} 處差異", { n: hunks.length })}</span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setFoldOn((v) => !v)} aria-pressed={foldOn}
            className={`inline-flex items-center gap-1 h-6 px-2 rounded ${foldOn ? "bg-accent/15 text-accent" : "text-fg/55 hover:bg-fg/10 hover:text-fg"}`}
            title={t("摺疊相同的行，只看差異前後幾行")}>
            {foldOn ? <FoldVertical size={12} /> : <UnfoldVertical size={12} />}{t("只看差異")}
          </button>
          <IconButton icon={ChevronUp} label={t("上一處差異")} iconSize={14} box="w-6 h-6" disabled={hunks.length < 2} onClick={() => go(-1)} />
          <span className="mono tabular-nums text-fg/50 min-w-[3ch] text-center">{hunks.length ? `${cur + 1}/${hunks.length}` : "0/0"}</span>
          <IconButton icon={ChevronDown} label={t("下一處差異")} iconSize={14} box="w-6 h-6" disabled={hunks.length < 2} onClick={() => go(1)} />
        </span>
      </div>
      <div className="grid grid-cols-[2.75rem_1fr_2.75rem_1fr] text-[11px] text-fg/50 border-b border-fg/10 bg-inset">
        <div />
        <div className="px-2 py-1 truncate">{srcLabel}</div>
        <div className="border-l border-fg/10" />
        <div className="px-2 py-1 truncate">{dstLabel}</div>
      </div>
      <div className="max-h-[50vh] overflow-auto mono code-scale leading-tight">
        {items.map((it) => {
          if (it.kind === "fold") {
            return (
              <button key={`f${it.from}`} type="button" onClick={() => setExpanded((p) => new Set(p).add(it.from))}
                className="w-full text-center text-[11px] text-fg/45 bg-fg/[0.04] hover:bg-fg/[0.08] hover:text-fg/70 py-0.5 border-y border-fg/5">
                {t("⋯ 展開 {n} 行相同 ⋯", { n: it.to - it.from })}
              </button>
            );
          }
          const p = pairs[it.index];
          const w = words(p);
          const inCur = hunkOf.get(it.index) === cur && hunks.length > 0;
          return (
            <div key={it.index} ref={(el) => { if (el) rowRefs.current.set(it.index, el); else rowRefs.current.delete(it.index); }}
              className={`grid grid-cols-[2.75rem_1fr_2.75rem_1fr] ${inCur ? "shadow-[inset_2px_0_0_0_rgb(var(--c-accent))]" : ""}`}>
              <LineNo n={p.ln} changed={p.changed && !!p.left} side="del" />
              <Cell line={p.left} side="del" tokens={w?.l} />
              <LineNo n={p.rn} changed={p.changed && !!p.right} side="add" />
              <Cell line={p.right} side="add" tokens={w?.r} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LineNo({ n, changed, side }: { n: number | null; changed: boolean; side: "del" | "add" }) {
  const tone = !changed ? "text-fg/25" : side === "del" ? "text-red-300/70 bg-red-500/10" : "text-emerald-300/70 bg-emerald-500/10";
  return <div className={`pr-1.5 text-right tabular-nums select-none ${tone} ${side === "add" ? "border-l border-fg/10" : ""}`}>{n ?? ""}</div>;
}

function Cell({ line, side, tokens }: { line: { type: string; text: string } | null; side: "del" | "add"; tokens?: DiffToken[] }) {
  const cls = !line
    ? "bg-fg/[0.03]"
    : line.type === "same"
      ? "text-fg/60"
      : side === "del"
        ? "bg-red-500/10 text-red-300/90"
        : "bg-emerald-500/10 text-emerald-300/90";
  const mark = side === "del" ? "bg-red-500/30 rounded-[2px]" : "bg-emerald-500/30 rounded-[2px]";
  return (
    <div className={`px-2 whitespace-pre-wrap break-all ${cls}`}>
      {tokens
        ? tokens.map((x, i) => (x.type === "same" ? <span key={i}>{x.text}</span> : <span key={i} className={mark}>{x.text}</span>))
        : line ? line.text || " " : " "}
    </div>
  );
}

const colSpec = (c: ColumnInfo) =>
  `${c.data_type}${c.nullable ? "" : " NOT NULL"}${c.default != null && c.default !== "" ? ` DEFAULT ${c.default}` : ""}${c.extra ? ` ${c.extra}` : ""}${c.comment ? ` -- ${c.comment}` : ""}`;
const idxSpec = (i: IndexInfo) => `${i.primary ? "PRIMARY " : i.unique ? "UNIQUE " : ""}(${i.columns.join(", ")})`;
const fkSpec = (f: ForeignKeyDef) => `(${f.columns.join(", ")}) → ${f.ref_table}(${f.ref_columns.join(", ")})`;

/** 變更列：兩側規格做字詞級 diff，只把真正變動的片段打亮（型別 / 長度 / 預設值…），其餘照舊。 */
function Changed({ a, b }: { a: string; b: string }) {
  const toks = diffTokens(a, b);
  const fine = tokenSimilarity(toks) >= WORD_DIFF_MIN_SIMILARITY;
  const render = (side: "del" | "add") => (fine
    ? toks.filter((x) => x.type !== (side === "del" ? "add" : "del")).map((x, i) =>
      x.type === "same" ? <span key={i}>{x.text}</span> : <span key={i} className={side === "del" ? "bg-red-500/30 rounded-[2px]" : "bg-emerald-500/30 rounded-[2px]"}>{x.text}</span>)
    : (side === "del" ? a : b));
  return (<><span className="text-fg/80">{render("del")}</span><span className="text-fg/35"> → </span><span className="text-fg/80">{render("add")}</span></>);
}

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
        {tone === "chg" ? <Changed a={a ?? ""} b={b ?? ""} /> : (a ?? b)}
      </span>
    </div>
  );
  const changedAttrs = (attrs: string[]) => attrs.map((a) => t(({ data_type: "型別", nullable: "可空", default: "預設值", extra: "額外", comment: "註解" } as Record<string, string>)[a] ?? a)).join("、");
  return (
    <div className="space-y-3">
      <div className="text-[11px] text-fg/40">{t("變更列的寫法：來源 → 目標；打亮的片段是真正不同的地方。")}</div>
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
