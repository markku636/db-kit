// YAML 編輯器（CodeMirror）：語法上色用一個小型 StreamLanguage（鍵、字串、數字、布林、註解、文件分隔），
// 不另外引入 YAML 語言套件。資源分頁的 YAML 子頁與「套用 YAML」對話框共用。
import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { StreamLanguage, type StringStream } from "@codemirror/language";
import { useTheme } from "./theme";
import { resolveEditorTheme } from "./editorThemes";

interface YamlState {
  /** 目前這一行是否已過了 `key:`（之後的 token 當值）。 */
  afterKey: boolean;
  /** 區塊字串（`|` / `>`）的縮排：大於此縮排的行都是字串。 */
  blockIndent: number | null;
}

export const yamlLanguage = StreamLanguage.define<YamlState>({
  name: "yaml",
  startState: () => ({ afterKey: false, blockIndent: null }),
  token(stream: StringStream, state: YamlState) {
    if (stream.sol()) {
      state.afterKey = false;
      if (state.blockIndent !== null) {
        if (stream.indentation() > state.blockIndent || stream.match(/^\s*$/, false)) {
          stream.skipToEnd();
          return "string";
        }
        state.blockIndent = null;
      }
      if (stream.match(/^(---|\.\.\.)\s*$/)) return "meta";
    }
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^-(?=\s|$)/)) return "punctuation";
    // key:（含引號鍵）
    if (!state.afterKey && stream.match(/^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s#'"][^:#]*?)\s*:(?=\s|$)/)) {
      state.afterKey = true;
      return "propertyName";
    }
    if (stream.match(/^[|>][+-]?\d*\s*$/)) {
      state.blockIndent = stream.indentation();
      return "punctuation";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^']|'')*'?/)) return "string";
    if (stream.match(/^[&*][^\s,\]}]+/)) return "labelName";
    if (stream.match(/^!\S+/)) return "typeName";
    if (stream.match(/^(true|false|yes|no|on|off|null|~)(?=\s*(#|$|,|\]|\}))/i)) return "atom";
    if (stream.match(/^[-+]?(\d[\d_]*(\.\d+)?([eE][-+]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan)(?=\s*(#|$|,|\]|\}))/)) return "number";
    if (stream.match(/^[[\]{},]/)) return "punctuation";
    // 一般純量：吃到行尾或註解前。
    stream.eatWhile(/[^#]/);
    return "string";
  },
});

const baseTheme = EditorView.theme({
  "&": { fontSize: "var(--code-font-size, 13px)" },
  ".cm-scroller": { fontFamily: '"JetBrains Mono", Consolas, monospace' },
});

export default function K8sYamlEditor({ value, onChange, readOnly, className = "h-full", autoFocus }: {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  className?: string;
  autoFocus?: boolean;
}) {
  const themeId = useTheme((s) => s.themeId);
  const appTheme = useTheme((s) => s.theme);
  const extensions = useMemo(() => [yamlLanguage, baseTheme], []);
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      theme={resolveEditorTheme(themeId, appTheme)}
      extensions={extensions}
      height="100%"
      className={className}
      autoFocus={autoFocus}
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly, bracketMatching: true, closeBrackets: false, autocompletion: false, indentOnInput: false }}
    />
  );
}
