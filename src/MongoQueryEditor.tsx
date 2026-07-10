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

// Mongo 查詢編輯器（取代原本的 <textarea>）：JSON 語法高亮 + 即時 JSON lint +
// 三路自動完成 —— DSL 鍵、$ 聚合階段 / 查詢運算子、目標集合的欄位名（取樣 schema）。
// 與 SqlEditor 同視覺 / 同快捷鍵（F6 / Ctrl+Enter 執行、Tab 縮排）。

export interface MongoQueryEditorHandle {
  insertText: (text: string) => void;
  focus: () => void;
}

// 查詢 DSL 頂層鍵（與後端 mongo.rs query()/explain() 對齊）。
const DSL_KEYS = [
  "db", "collection", "filter", "sort", "projection", "limit",
  "pipeline", "insert", "update", "delete", "verbosity",
];

// 聚合管線階段 + 常用查詢運算子（$ 開頭時提示）。
const DOLLAR_OPS = [
  "$match", "$group", "$sort", "$project", "$limit", "$skip", "$lookup", "$unwind",
  "$count", "$facet", "$sample", "$addFields", "$set", "$unset", "$out", "$merge", "$indexStats",
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin",
  "$and", "$or", "$not", "$nor", "$exists", "$regex", "$options", "$type", "$elemMatch",
  "$sum", "$avg", "$min", "$max", "$first", "$last", "$push", "$addToSet",
];

// 背景透明改由 transparentBg 承擔，只在「跟隨 App」模式附加（自訂主題需保留自身背景色）。
// .cm-scroller 明確兩軸 auto：理由同 SqlEditor（外層 overflow-hidden，不可依賴隱式推導）。
const baseTheme = EditorView.theme({
  "&": { fontSize: "13px", height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  ".cm-gutters": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  "&.cm-focused": { outline: "none" },
});

// 從草稿文字抓目標 db / collection（容忍編輯中的不完整 JSON，用 regex 而非 JSON.parse）。
function extractTarget(text: string): { db: string; coll: string } | null {
  const db = /"db"\s*:\s*"([^"]+)"/.exec(text);
  const coll = /"collection"\s*:\s*"([^"]+)"/.exec(text);
  return db && coll ? { db: db[1], coll: coll[1] } : null;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 連線 id：供欄位名補全抓取樣 schema（tableColumns）。 */
  connId: string | null;
  onSubmit?: () => void; // F6 / Ctrl+Enter
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

const MongoQueryEditor = forwardRef<MongoQueryEditorHandle, Props>(function MongoQueryEditor(
  { value, onChange, connId, onSubmit, placeholder, className, autoFocus },
  ref,
) {
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

  // 欄位名快取（key = db.collection）：背景抓一次，抓好後補全即時可用；失敗記空陣列不重試。
  const fieldsRef = useRef<Map<string, string[]>>(new Map());
  useEffect(() => {
    if (!connId) return;
    const target = extractTarget(value);
    if (!target || fieldsRef.current.has(`${target.db}.${target.coll}`)) return;
    const key = `${target.db}.${target.coll}`;
    const t = setTimeout(() => {
      api
        .tableColumns(connId, target.db, target.coll)
        .then((cols) => fieldsRef.current.set(key, cols.map((c) => c.name)))
        .catch(() => fieldsRef.current.set(key, []));
    }, 400); // debounce：打字中不狂打後端
    return () => clearTimeout(t);
  }, [value, connId]);

  const extensions = useMemo<Extension[]>(() => {
    // 三路補全：依已輸入 token 分流（$ 開頭 → 運算子；其餘 → DSL 鍵 + 欄位名）。
    const source: CompletionSource = (ctx) => {
      const word = ctx.matchBefore(/"?[$\w.]*/);
      if (!word || (word.from === word.to && !ctx.explicit)) return null;
      const quoted = word.text.startsWith('"');
      const typed = quoted ? word.text.slice(1) : word.text;
      const from = word.from + (quoted ? 1 : 0);
      // 已在字串內（有開頭引號）就補純文字，否則連引號一起補。
      const mk = (label: string, type: string, detail?: string): Completion => ({
        label,
        type,
        detail,
        apply: quoted ? label : `"${label}"`,
      });
      const opts: Completion[] = [];
      if (typed.startsWith("$")) {
        for (const op of DOLLAR_OPS) opts.push(mk(op, "keyword"));
      } else {
        for (const k of DSL_KEYS) opts.push(mk(k, "property", "查詢 DSL"));
        const target = extractTarget(ctx.state.doc.toString());
        if (target) {
          for (const f of fieldsRef.current.get(`${target.db}.${target.coll}`) ?? []) {
            opts.push(mk(f, "variable", "欄位"));
          }
        }
      }
      return { from, options: opts, validFor: /^[$\w.]*$/ };
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

export default MongoQueryEditor;
