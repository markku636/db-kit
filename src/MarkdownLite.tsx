// 極簡 Markdown 渲染（不引入額外套件）：聊天面板與審查並執行的 AI 審查結果共用。
// 模型輸出是不可信文字：一律當 React 文字節點輸出，不走 dangerouslySetInnerHTML。
import type { ReactNode } from "react";
import { api } from "./api";

// ---- 極簡 Markdown：純文字 + 反引號圍欄程式碼區塊（不引入額外套件）----
export type Block = { type: "text"; text: string } | { type: "code"; lang: string; code: string };

export function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      const val = text.slice(last, m.index).replace(/^\n+|\n+$/g, "");
      if (val) out.push({ type: "text", text: val });
    }
    out.push({ type: "code", lang: (m[1] || "").toLowerCase(), code: m[2].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  if (last < text.length) {
    const val = text.slice(last).replace(/^\n+|\n+$/g, "");
    if (val) out.push({ type: "text", text: val });
  }
  if (out.length === 0) out.push({ type: "text", text });
  return out;
}

// 行內樣式：`code`、**bold**、[text](url) 連結（其餘為純文字）。
export function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={`${keyBase}-${i}`} className="mono text-[12px] px-1 py-0.5 rounded bg-fg/10 text-fg/90">{tok.slice(1, -1)}</code>,
      );
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={`${keyBase}-${i}`} className="font-semibold text-fg">{tok.slice(2, -2)}</strong>);
    } else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const label = lm?.[1] ?? tok;
      const url = lm?.[2] ?? "";
      const external = /^https?:\/\//i.test(url);
      nodes.push(
        <a
          key={`${keyBase}-${i}`}
          href={external ? url : undefined}
          title={url}
          onClick={(e) => { e.preventDefault(); if (external) api.openExternal(url).catch(() => {}); }}
          className={external ? "text-blue-400 hover:text-blue-300 underline cursor-pointer" : "text-fg/80"}
        >
          {label}
        </a>,
      );
    }
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/;
function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

// 文字區塊：逐行處理表格（| a | b |）、標題（#）、清單（- / 1.）、空行間距，其餘為段落；行內再套 renderInline。
export function TextBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 表格：目前列為 |...| 且下一列為分隔列（|---|）。
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitTableRow(line);
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && TABLE_ROW.test(lines[j]) && !TABLE_SEP.test(lines[j])) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      out.push(
        <div key={i} className="overflow-auto">
          <table className="text-[12px] border-collapse">
            <thead>
              <tr>{header.map((c, k) => <th key={k} className="border border-fg/10 px-2 py-1 text-left font-semibold">{renderInline(c, `th${i}-${k}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci} className="border border-fg/10 px-2 py-1 align-top">{renderInline(c, `td${i}-${ri}-${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j;
      continue;
    }
    // 標題支援到六級：diff.md 的「刪除的列 / 新增的列」是四級標題，模型回覆也常用 ####。
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const num = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (h) {
      out.push(<div key={i} className="font-semibold text-fg mt-1 break-words">{renderInline(h[2], `h${i}`)}</div>);
      i++;
    } else if (quote) {
      const qlines: string[] = [];
      while (i < lines.length) {
        const q = /^\s*>\s?(.*)$/.exec(lines[i]);
        if (q) { qlines.push(q[1]); i++; } else break;
      }
      out.push(
        <blockquote key={i} className="border-l-2 border-fg/20 pl-2 text-fg/70 italic break-words">
          {qlines.map((ql, k) => <p key={k} className="leading-relaxed">{renderInline(ql, `q${i}-${k}`)}</p>)}
        </blockquote>,
      );
    } else if (bullet || num) {
      const items: { num?: string; text: string }[] = [];
      while (i < lines.length) {
        const b = /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        const n = /^\s*(\d+)\.\s+(.*)$/.exec(lines[i]);
        if (b) { items.push({ text: b[1] }); i++; }
        else if (n) { items.push({ num: n[1], text: n[2] }); i++; }
        else break;
      }
      out.push(
        <ul key={i} className="space-y-0.5 pl-1">
          {items.map((it, j) => (
            <li key={j} className="flex gap-1.5 break-words">
              <span className="text-fg/40 shrink-0">{it.num ? `${it.num}.` : "•"}</span>
              <span className="flex-1">{renderInline(it.text, `li${i}-${j}`)}</span>
            </li>
          ))}
        </ul>,
      );
    } else if (line.trim() === "") {
      out.push(<div key={i} className="h-1.5" />);
      i++;
    } else {
      out.push(<p key={i} className="leading-relaxed break-words">{renderInline(line, `p${i}`)}</p>);
      i++;
    }
  }
  return <div className="text-[13px] space-y-0.5">{out}</div>;
}
