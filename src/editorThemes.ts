import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// 編輯器語法高亮主題。配色移植自 Notepad++ Dracula PRO 系列 theme XML
// （GlobalStyles + SQL lexer 色值，規劃期一次抽取定稿），名稱改為寶石系、不用原名。
export type EditorThemeId =
  | "amethyst"
  | "moonstone"
  | "jade"
  | "garnet"
  | "amber"
  | "ruby"
  | "obsidian";

// "auto" = 跟隨 App 深淺色（沿用 @uiw 內建 light/dark 主題，維持原視覺）。
export type EditorThemeChoice = "auto" | EditorThemeId;

interface ThemeColors {
  bg: string;
  fg: string;
  keyword: string;
  number: string;
  string: string;
  operator: string;
  comment: string;
  caret: string;
  selection: string;
  activeLine: string;
  gutterFg: string; // 行號用 comment 色系（XML 原值為主前景色，直接用會過亮）
}

export interface EditorThemeDef {
  id: EditorThemeId;
  label: string;
  dark: boolean;
  colors: ThemeColors;
}

export const EDITOR_THEMES: EditorThemeDef[] = [
  {
    id: "amethyst",
    label: "Amethyst 紫水晶",
    dark: true,
    colors: {
      bg: "#22212C", fg: "#F8F8F2", keyword: "#FF80BF", number: "#9580FF",
      string: "#FFFF80", operator: "#FF80BF", comment: "#7970A9",
      caret: "#F8F8F2", selection: "#736C93", activeLine: "#454158", gutterFg: "#7970A9",
    },
  },
  {
    id: "moonstone",
    label: "Moonstone 月光石",
    dark: false,
    colors: {
      bg: "#F5F5F5", fg: "#1F1F1F", keyword: "#A3144D", number: "#644AC9",
      string: "#846E15", operator: "#A3144D", comment: "#635D97",
      caret: "#1F1F1F", selection: "#736C93", activeLine: "#CFCFDE", gutterFg: "#635D97",
    },
  },
  {
    id: "jade",
    label: "Jade 翡翠",
    dark: true,
    colors: {
      bg: "#212C2A", fg: "#F8F8F2", keyword: "#FF80BF", number: "#9580FF",
      string: "#FFFF80", operator: "#FF80BF", comment: "#70A99F",
      caret: "#F8F8F2", selection: "#6C938C", activeLine: "#415854", gutterFg: "#70A99F",
    },
  },
  {
    id: "garnet",
    label: "Garnet 石榴石",
    dark: true,
    colors: {
      bg: "#2A212C", fg: "#F8F8F2", keyword: "#FF80BF", number: "#9580FF",
      string: "#FFFF80", operator: "#FF80BF", comment: "#9F70A9",
      caret: "#F8F8F2", selection: "#8C6C93", activeLine: "#544158", gutterFg: "#9F70A9",
    },
  },
  {
    id: "amber",
    label: "Amber 琥珀",
    dark: true,
    colors: {
      bg: "#2C2A21", fg: "#F8F8F2", keyword: "#FF80BF", number: "#9580FF",
      string: "#FFFF80", operator: "#FF80BF", comment: "#A99F70",
      caret: "#F8F8F2", selection: "#938C6C", activeLine: "#585441", gutterFg: "#A99F70",
    },
  },
  {
    id: "ruby",
    label: "Ruby 紅寶石",
    dark: true,
    colors: {
      bg: "#2C2122", fg: "#F8F8F2", keyword: "#FF80BF", number: "#9580FF",
      string: "#FFFF80", operator: "#FF80BF", comment: "#A97079",
      caret: "#F8F8F2", selection: "#936C73", activeLine: "#584145", gutterFg: "#A97079",
    },
  },
  {
    id: "obsidian",
    label: "Obsidian 黑曜石",
    dark: true,
    colors: {
      bg: "#0B0D0F", fg: "#F8F8F2", keyword: "#FF80BF", number: "#9580FF",
      string: "#FFFF80", operator: "#FF80BF", comment: "#708CA9",
      caret: "#F8F8F2", selection: "#6C8093", activeLine: "#414D58", gutterFg: "#708CA9",
    },
  },
];

export function getEditorThemeDef(id: string): EditorThemeDef | undefined {
  return EDITOR_THEMES.find((d) => d.id === id);
}

export function isEditorThemeChoice(v: unknown): v is EditorThemeChoice {
  return v === "auto" || EDITOR_THEMES.some((d) => d.id === v);
}

// auto 模式（跟隨 App）附加：編輯器 / 行號背景透明，透出 app 面板底色（原 baseTheme 行為）。
// 指定主題時不可附加，否則會蓋掉主題自身背景。
export const transparentBg = EditorView.theme({
  "&": { backgroundColor: "transparent" },
  ".cm-gutters": { backgroundColor: "transparent" },
});

// 同一主題的 extension 只建一次（identity 穩定，避免 CodeMirror 重複 reconfigure）。
const cache = new Map<EditorThemeId, Extension>();

export function buildEditorTheme(def: EditorThemeDef): Extension {
  const hit = cache.get(def.id);
  if (hit) return hit;
  const c = def.colors;
  const view = EditorView.theme(
    {
      "&": { backgroundColor: c.bg, color: c.fg },
      ".cm-content": { caretColor: c.caret },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: c.caret },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: c.selection },
      // 當前行帶 60% 透明度：CodeMirror 的 activeLine 疊在選取層之上，全不透明會遮住選取色。
      ".cm-activeLine": { backgroundColor: c.activeLine + "99" },
      ".cm-activeLineGutter": { backgroundColor: c.activeLine },
      ".cm-gutters": { backgroundColor: c.bg, color: c.gutterFg, border: "none" },
      ".cm-tooltip": { backgroundColor: c.activeLine, color: c.fg, border: "none" },
      ".cm-tooltip-autocomplete": {
        "& > ul > li[aria-selected]": { backgroundColor: c.selection, color: c.fg },
      },
      ".cm-panels": { backgroundColor: c.bg, color: c.fg },
    },
    { dark: def.dark },
  );
  const highlight = HighlightStyle.define([
    // SQL：型別（INT 等）在 Notepad++ SQL lexer 併入 KEYWORD 色，這裡比照。
    { tag: [t.keyword, t.typeName, t.operatorKeyword, t.modifier], color: c.keyword },
    { tag: t.operator, color: c.operator },
    { tag: t.punctuation, color: c.fg },
    { tag: [t.number, t.bool, t.null], color: c.number },
    { tag: [t.string, t.special(t.string)], color: c.string },
    { tag: t.comment, color: c.comment }, // lineComment / blockComment 為子 tag，自動涵蓋
    { tag: t.propertyName, color: c.keyword }, // Mongo/JSON 的 key
    { tag: [t.name, t.variableName], color: c.fg },
  ]);
  const ext: Extension = [view, syntaxHighlighting(highlight)];
  cache.set(def.id, ext);
  return ext;
}

// 編輯器 theme prop 的統一入口：auto → @uiw 內建 light/dark；指定主題 → 自訂 extension。
// 未知 id（localStorage 殘值）容錯回 auto 行為。回傳值 identity 穩定，呼叫端不需 memo。
export function resolveEditorTheme(
  choice: EditorThemeChoice,
  appTheme: "dark" | "light",
): "light" | "dark" | Extension {
  if (choice !== "auto") {
    const def = getEditorThemeDef(choice);
    if (def) return buildEditorTheme(def);
  }
  return appTheme === "light" ? "light" : "dark";
}
