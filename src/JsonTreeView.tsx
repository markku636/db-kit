import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import Icon from "./ui/Icon";
import { copyToClipboard } from "./ui";
import { jsonPathJoin } from "./cellViews";
import { useT } from "./i18n";

// JSON 樹：可摺疊的物件 / 陣列，值依型別上色。點任一列複製它的 JSONPath（`$.items[0].sku`），
// 寫 JSON_EXTRACT / ->> 查詢時不必自己數層級。小文件（≤ 200 個節點）全部展開，大的只展開前兩層。

const MAX_CHILDREN = 500;
const SMALL_DOC_NODES = 200;

function countNodes(v: unknown, limit: number): number {
  if (v === null || typeof v !== "object") return 1;
  let n = 1;
  for (const c of Object.values(v as object)) {
    n += countNodes(c, limit - n);
    if (n > limit) break;
  }
  return n;
}

export default function JsonTreeView({ value }: { value: object }) {
  const openDepth = countNodes(value, SMALL_DOC_NODES) <= SMALL_DOC_NODES ? Infinity : 2;
  return (
    <div className="mono text-xs leading-5 select-text" data-json-tree>
      <Node k={null} v={value} path="$" depth={0} openDepth={openDepth} />
    </div>
  );
}

function scalar(v: unknown): { text: string; cls: string } {
  if (v === null) return { text: "null", cls: "text-fg/40 italic" };
  if (typeof v === "string") return { text: JSON.stringify(v), cls: "text-emerald-300" };
  if (typeof v === "number") return { text: String(v), cls: "text-sky-300" };
  if (typeof v === "boolean") return { text: String(v), cls: "text-amber-300" };
  return { text: String(v), cls: "" };
}

function Node({ k, v, path, depth, openDepth }: { k: string | number | null; v: unknown; path: string; depth: number; openDepth: number }) {
  const t = useT();
  const isObj = v !== null && typeof v === "object";
  const [open, setOpen] = useState(depth < openDepth);
  const label = k === null ? null : (
    <span className={typeof k === "number" ? "text-fg/40" : "text-violet-300"}>{typeof k === "number" ? k : JSON.stringify(k)}: </span>
  );
  const copyPath = () => void copyToClipboard(path, t("已複製路徑 {path}", { path }));
  if (!isObj) {
    const s = scalar(v);
    return (
      <div className="pl-4 hover:bg-fg/5 rounded cursor-pointer break-all" style={{ paddingLeft: depth * 14 + 16 }} title={path} onClick={copyPath}>
        {label}<span className={s.cls}>{s.text}</span>
      </div>
    );
  }
  const entries: Array<[string | number, unknown]> = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v as object);
  const summary = Array.isArray(v) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <div>
      <div className="hover:bg-fg/5 rounded cursor-pointer flex items-center" style={{ paddingLeft: depth * 14 }} title={path}
        onClick={() => setOpen((o) => !o)} onDoubleClick={copyPath}>
        <Icon icon={open ? ChevronDown : ChevronRight} size={12} className="text-fg/40 shrink-0 mr-1" />
        {label}<span className="text-fg/40">{summary}</span>
      </div>
      {open && (
        <>
          {entries.slice(0, MAX_CHILDREN).map(([ck, cv]) => (
            <Node key={String(ck)} k={ck} v={cv} path={jsonPathJoin(path, ck)} depth={depth + 1} openDepth={openDepth} />
          ))}
          {entries.length > MAX_CHILDREN && (
            <div className="text-fg/40" style={{ paddingLeft: (depth + 1) * 14 + 16 }}>
              {t("… 另有 {n} 項未顯示", { n: entries.length - MAX_CHILDREN })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
