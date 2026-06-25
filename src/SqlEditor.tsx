import { useCallback, useEffect, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { sql, MySQL, PostgreSQL, SQLite, StandardSQL, type SQLDialect, type SQLNamespace } from "@codemirror/lang-sql";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { DbKind } from "./api";
import { useTheme } from "./theme";
import { lintSqlStructure } from "./sql";

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
  postgres: PostgreSQL,
  sqlite: SQLite,
  mongo: StandardSQL,
  redis: StandardSQL,
  external: MySQL, // 外部 gateway（qland）講 MySQL
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
export default function SqlEditor({
  value,
  onChange,
  kind,
  schema,
  diagnostics,
  onSubmit,
  onSelectionChange,
  placeholder,
  className,
  autoFocus,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  kind: DbKind;
  /** 表/欄結構，供自動完成（FROM/JOIN 後補表名、欄名）。 */
  schema?: SQLNamespace;
  diagnostics?: SqlDiagnostic[];
  onSubmit?: (s: SqlSubmit) => void; // F6 / Ctrl+Enter 觸發（如「執行」）
  /** 選取文字變動時回呼（供呼叫端讓「執行」鈕在有選取時顯示「執行選取」）。 */
  onSelectionChange?: (selection: string | null) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  readOnly?: boolean;
}) {
  const theme = useTheme((s) => s.theme);
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
    const ext: Extension[] = [
      // schema 提供表/欄自動完成；upperCaseKeywords 讓補入的關鍵字為大寫（符合 SQL 慣例）。
      sql({ dialect: DIALECT[kind] ?? StandardSQL, schema, upperCaseKeywords: true }),
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
  }, [kind, diagnostics, schema]);

  return (
    <CodeMirror
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
}
