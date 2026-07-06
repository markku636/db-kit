import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { sql, MySQL, MariaSQL, PostgreSQL, SQLite, MSSQL, PLSQL, StandardSQL, type SQLDialect, type SQLNamespace } from "@codemirror/lang-sql";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { snippetCompletion, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { DbKind } from "./api";
import { useTheme } from "./theme";
import { lintSqlStructure } from "./sql";

// SQL 片段（供編輯器自動完成展開：輸入名稱 → 補入 body）。
export interface EditorSnippet { name: string; body: string; desc?: string }
// 外部可命令式呼叫的方法（供「片段」工具列在游標處插入）。
export interface SqlEditorHandle {
  insertText: (text: string) => void;
  focus: () => void;
  // 由編輯器外的「執行」鈕觸發，走與鍵盤 F6 / Ctrl+Enter 同一套 selection / cursor 邏輯：
  // runAll=false → 執行游標所在語句 / 選取段（DataGrip / DBeaver 主執行鍵行為）；runAll=true → 整段。
  submit: (runAll: boolean) => void;
}

// 送出（執行）時的上下文：選取文字、游標位移、是否整段執行（F6）。
export interface SqlSubmit {
  selection: string | null; // 反白選取的文字（無選取為 null）
  cursorOffset: number; // 游標位置（字元位移），供「執行游標所在語句」定位
  runAll: boolean; // true = F6（整個編輯器）；false = Mod/Ctrl+Enter（選取或游標語句）
}

// 外部（後端）診斷：以行號或字元位移定位，疊加到 CodeMirror 的 lint 標記上。
export interface SqlDiagnostic {
  line?: number; // 1-based（後端語法錯誤行號）；無 from 時用來定位整行
  from?: number; // 字元位移（優先於 line）
  to?: number;
  severity?: "error" | "warning" | "info";
  message: string;
}

const DIALECT: Record<DbKind, SQLDialect> = {
  mysql: MySQL,
  mariadb: MariaSQL,
  postgres: PostgreSQL,
  sqlite: SQLite,
  mssql: MSSQL,
  oracle: PLSQL,
  mongo: StandardSQL,
  redis: StandardSQL,
  external: MySQL, // 外部 gateway 講 MySQL
};

// 1-based 行號 → 整行的字元位移範圍。
function lineToRange(doc: string, line: number): { from: number; to: number } {
  const lines = doc.split("\n");
  const idx = Math.min(Math.max(line, 1), lines.length) - 1;
  let from = 0;
  for (let k = 0; k < idx; k++) from += lines[k].length + 1;
  return { from, to: from + lines[idx].length };
}

// 字型 / 尺寸微調（與 app 既有 mono / text-sm 視覺一致；token 配色沿用 theme prop 的 dark/light）。
const baseTheme = EditorView.theme({
  "&": { fontSize: "13px", height: "100%", backgroundColor: "transparent" },
  ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  ".cm-gutters": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
});

/**
 * 共用 SQL 編輯器：CodeMirror 6 + 方言感知語法高亮 + 即時結構檢查 + 後端診斷疊加。
 * 取代散落各對話框的 <textarea>（RoutinesDialog / CreateViewDialog）。
 */
interface SqlEditorProps {
  value: string;
  onChange: (v: string) => void;
  kind: DbKind;
  /** 表/欄結構，供自動完成（FROM/JOIN 後補表名、欄名）。 */
  schema?: SQLNamespace;
  /** SQL 片段，供自動完成展開（輸入名稱即補入內容）。 */
  snippets?: EditorSnippet[];
  diagnostics?: SqlDiagnostic[];
  onSubmit?: (s: SqlSubmit) => void; // F6 / Ctrl+Enter 觸發（如「執行」）
  /** 選取文字變動時回呼（供呼叫端追蹤選取段，執行時只跑選取）。 */
  onSelectionChange?: (selection: string | null) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
}

const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor({
  value,
  onChange,
  kind,
  schema,
  snippets,
  diagnostics,
  onSubmit,
  onSelectionChange,
  placeholder,
  className,
  autoFocus,
  readOnly,
}, ref) {
  const theme = useTheme((s) => s.theme);
  // CodeMirror 實例 ref：供 insertText 於游標處插入（片段工具列用）。
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
    submit: (runAll: boolean) => {
      const view = cmRef.current?.view;
      if (!view) return;
      const sel = view.state.selection.main;
      const selection = sel.empty ? null : view.state.sliceDoc(sel.from, sel.to);
      submitRef.current?.({ selection, cursorOffset: sel.head, runAll });
    },
  }), []);
  // onSubmit 以 ref 持有，避免每次 render 重建 extensions（CodeMirror 會重新配置）。
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  // 選取回呼與上次選取值（以 ref 持有，使 onUpdate handler 維持穩定 identity）。
  const selChangeRef = useRef(onSelectionChange);
  selChangeRef.current = onSelectionChange;
  const lastSelRef = useRef<string | null>(null);
  const handleUpdate = useCallback((vu: ViewUpdate) => {
    const cb = selChangeRef.current;
    if (!cb) return;
    if (!vu.selectionSet && !vu.docChanged) return;
    const sel = vu.state.selection.main;
    const text = sel.empty ? null : vu.state.sliceDoc(sel.from, sel.to);
    if (text !== lastSelRef.current) {
      lastSelRef.current = text;
      cb(text);
    }
  }, []);
  // 新掛載的編輯器必無選取；主動回報 null，校正父層可能殘留的舊選取
  //（切換連線時 SqlEditor 可能因 supportsExplain 翻轉而重新掛載，lastSelRef 重置為 null 會吞掉校正回呼）。
  useEffect(() => {
    selChangeRef.current?.(null);
    lastSelRef.current = null;
  }, []);

  const extensions = useMemo<Extension[]>(() => {
    // schema 提供表/欄自動完成；upperCaseKeywords 讓補入的關鍵字為大寫（符合 SQL 慣例）。
    const lang = sql({ dialect: DIALECT[kind] ?? StandardSQL, schema, upperCaseKeywords: true });
    const ext: Extension[] = [
      lang,
      lintGutter(),
      baseTheme,
      EditorView.lineWrapping,
      // 即時結構檢查（前端，零誤報）+ 後端語法診斷（驗證後）合併為 lint 來源。
      linter(
        (view) => {
          const doc = view.state.doc.toString();
          const out: Diagnostic[] = lintSqlStructure(doc).map((m) => ({
            from: Math.min(m.from, doc.length),
            to: Math.min(m.to, doc.length),
            severity: m.severity,
            message: m.message,
          }));
          for (const d of diagnostics ?? []) {
            let from = d.from;
            let to = d.to;
            if (from == null && d.line != null) {
              const r = lineToRange(doc, d.line);
              from = r.from;
              to = r.to;
            }
            if (from == null) {
              from = 0;
              const nl = doc.indexOf("\n");
              to = nl >= 0 ? nl : doc.length;
            }
            out.push({
              from: Math.min(from, doc.length),
              to: Math.min(to ?? from, doc.length),
              severity: d.severity ?? "error",
              message: d.message,
            });
          }
          return out;
        },
        { delay: 250 },
      ),
    ];
    // SQL 片段自動完成：把片段以 snippetCompletion 註冊為「此語言」的額外完成來源，
    // 與 schema 表/欄完成併存（CodeMirror 會合併語言資料的所有 autocomplete 來源）。
    if (snippets && snippets.length) {
      const options: Completion[] = snippets.map((s) =>
        snippetCompletion(s.body, { label: s.name, type: "text", detail: s.desc, boost: 2 }),
      );
      const snippetSource: CompletionSource = (ctx) => {
        const word = ctx.matchBefore(/\w+/);
        if (!word && !ctx.explicit) return null;
        return { from: word ? word.from : ctx.pos, options, validFor: /^\w*$/ };
      };
      ext.push(lang.language.data.of({ autocomplete: snippetSource }));
    }
    // 送出鍵（高優先，蓋過預設按鍵）：
    //  Mod-Enter = 執行選取或游標所在語句；F6 = 整段執行；Tab = 縮排（程式碼編輯慣例）。
    const fire = (view: EditorView, runAll: boolean) => {
      const sel = view.state.selection.main;
      const selection = sel.empty ? null : view.state.sliceDoc(sel.from, sel.to);
      submitRef.current?.({ selection, cursorOffset: sel.head, runAll });
      return true;
    };
    ext.push(
      Prec.high(
        keymap.of([
          { key: "Mod-Enter", run: (v) => fire(v, false) },
          { key: "F6", run: (v) => fire(v, true), preventDefault: true },
          indentWithTab,
        ]),
      ),
    );
    return ext;
  }, [kind, diagnostics, schema, snippets]);

  return (
    <CodeMirror
      ref={cmRef}
      className={className}
      value={value}
      onChange={onChange}
      onUpdate={handleUpdate}
      theme={theme === "light" ? "light" : "dark"}
      extensions={extensions}
      readOnly={readOnly}
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

export default SqlEditor;
