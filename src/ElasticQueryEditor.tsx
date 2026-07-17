import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter, lintGutter } from "@codemirror/lint";
import { autocompletion, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { api } from "./api";
import { useTheme } from "./theme";
import { resolveEditorTheme } from "./editorThemes";
import { useT } from "./i18n";

// Elasticsearch / OpenSearch 查詢編輯器（仿 MongoQueryEditor）：JSON 高亮 + 即時 lint +
// 三路補全 —— envelope 頂層鍵、DSL / 聚合關鍵字（bool / range / terms…）、目標 index 的欄位名。
// query envelope 契約：頂層必含 "index"，其餘鍵為 search body；count 查詢加 "count": true。
// 與 SqlEditor / MongoQueryEditor 同視覺與快捷鍵（F6 / Ctrl+Enter 執行、Tab 縮排）。

export interface ElasticQueryEditorHandle {
  insertText: (text: string) => void;
  focus: () => void;
}

// envelope 頂層鍵（與後端 db/elastic query() 對齊）。
const ENVELOPE_KEYS = [
  "index", "query", "aggs", "size", "from", "sort", "_source",
  "count", "highlight", "track_total_hits",
];

// DSL 查詢 / 聚合關鍵字（不含 $ 前綴，ES DSL 用純字串鍵）。
const DSL_KEYWORDS = [
  "bool", "must", "should", "must_not", "filter",
  "match", "match_all", "match_phrase", "multi_match", "term", "terms",
  "range", "wildcard", "prefix", "exists", "query_string", "nested",
  "gte", "gt", "lte", "lt", "boost", "operator", "fields",
  // 聚合類型
  "terms", "avg", "sum", "min", "max", "cardinality", "stats",
  "date_histogram", "histogram", "top_hits", "value_count", "percentiles",
  "field", "order", "size", "interval", "calendar_interval", "fixed_interval",
];

const baseTheme = EditorView.theme({
  "&": { fontSize: "13px", height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  ".cm-gutters": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  "&.cm-focused": { outline: "none" },
});

// 從草稿抓目標 index（容忍編輯中的不完整 JSON，用 regex 而非 JSON.parse）。萬用字元索引不抓欄位。
function extractIndex(text: string): string | null {
  const m = /"index"\s*:\s*"([^"*]+)"/.exec(text);
  return m ? m[1] : null;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 連線 id：供欄位名補全抓 mapping 攤平欄位（table_columns，database 固定為合成的 "cluster"）。 */
  connId: string | null;
  onSubmit?: () => void; // F6 / Ctrl+Enter
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

const ElasticQueryEditor = forwardRef<ElasticQueryEditorHandle, Props>(function ElasticQueryEditor(
  { value, onChange, connId, onSubmit, placeholder, className, autoFocus },
  ref,
) {
  const t = useT();
  const theme = useTheme((s) => s.theme);
  const themeId = useTheme((s) => s.themeId);
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      const view = cmRef.current?.view;
      if (!view) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    focus: () => cmRef.current?.view?.focus(),
  }), []);

  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;

  // 欄位名快取（key = index）：背景抓一次 mapping 攤平欄位，抓好後補全即時可用；失敗記空陣列不重試。
  const fieldsRef = useRef<Map<string, string[]>>(new Map());
  useEffect(() => {
    if (!connId) return;
    const index = extractIndex(value);
    if (!index || fieldsRef.current.has(index)) return;
    const timer = setTimeout(() => {
      api
        .tableColumns(connId, "cluster", index)
        .then((cols) => fieldsRef.current.set(index, cols.map((c) => c.name)))
        .catch(() => fieldsRef.current.set(index, []));
    }, 400); // debounce：打字中不狂打後端
    return () => clearTimeout(timer);
  }, [value, connId]);

  const extensions = useMemo<Extension[]>(() => {
    const source: CompletionSource = (ctx) => {
      const word = ctx.matchBefore(/"?[\w.]*/);
      if (!word || (word.from === word.to && !ctx.explicit)) return null;
      const quoted = word.text.startsWith('"');
      const from = word.from + (quoted ? 1 : 0);
      const mk = (label: string, type: string, detail?: string): Completion => ({
        label,
        type,
        detail,
        apply: quoted ? label : `"${label}"`,
      });
      const opts: Completion[] = [];
      for (const k of ENVELOPE_KEYS) opts.push(mk(k, "property", t("查詢欄位")));
      for (const k of DSL_KEYWORDS) opts.push(mk(k, "keyword", "DSL"));
      const index = extractIndex(ctx.state.doc.toString());
      if (index) {
        for (const f of fieldsRef.current.get(index) ?? []) opts.push(mk(f, "variable", t("欄位")));
      }
      return { from, options: opts, validFor: /^[\w.]*$/ };
    };

    return [
      json(),
      linter(jsonParseLinter(), { delay: 250 }),
      lintGutter(),
      baseTheme,
      EditorView.lineWrapping,
      autocompletion({ override: [source] }),
      Prec.high(
        keymap.of([
          { key: "Mod-Enter", run: () => { submitRef.current?.(); return true; } },
          { key: "F6", run: () => { submitRef.current?.(); return true; }, preventDefault: true },
          indentWithTab,
        ]),
      ),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <CodeMirror
      ref={cmRef}
      className={className}
      value={value}
      onChange={onChange}
      theme={resolveEditorTheme(themeId, theme)}
      extensions={extensions}
      autoFocus={autoFocus}
      placeholder={placeholder}
      height="100%"
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        autocompletion: true,
        highlightActiveLine: true,
        bracketMatching: true,
        closeBrackets: true,
      }}
    />
  );
});

export default ElasticQueryEditor;
