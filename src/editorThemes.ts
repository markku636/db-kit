import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// 編輯器語法高亮主題。配色由本機 Notepad++ theme XML
// （GlobalStyles + SQL lexer 色值，規劃期一次抽取定稿）取樣，名稱一律採寶石系。
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

export interface ThemeColors {
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

// 整個 app 的表面 / 強調 / 意圖色（統一主題用；編輯器 token 仍走 colors）。
// well/fg 直接沿用 colors.bg/colors.fg；表面 6 階由 buildAppVars 以 mix(colors.bg → top) 生成。
export interface AppPalette {
  top: string; // 最亮表面錨（elevated；與 colors.bg 之間內插出 well→elevated 上升景深）
  accent: string; // 強調色（本變體自家色系）
  onAccentDark?: boolean; // 省略＝依 accent 亮度自動判定實心 accent 上的文字明暗
  success: string;
  warning: string;
  danger: string;
  info: string;
  shadow: string; // 陰影基底 hex
  shadowStrength: number;
}

export interface EditorThemeDef {
  id: EditorThemeId;
  label: string;
  dark: boolean;
  colors: ThemeColors;
  app: AppPalette;
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
    app: {
      top: "#424450", accent: "#9580FF",
      success: "#8AFF80", warning: "#FFFF80", danger: "#FF9580", info: "#80FFEA",
      shadow: "#000000", shadowStrength: 0.5,
    },
  },
  {
    id: "moonstone",
    label: "Moonstone 月光石",
    dark: false,
    colors: {
      bg: "#ECECF3", fg: "#1F1F1F", keyword: "#A3144D", number: "#644AC9",
      string: "#846E15", operator: "#A3144D", comment: "#635D97",
      caret: "#1F1F1F", selection: "#736C93", activeLine: "#CFCFDE", gutterFg: "#635D97",
    },
    app: {
      top: "#FFFFFF", accent: "#644AC9",
      success: "#14710A", warning: "#846E15", danger: "#CB3A2A", info: "#036A96",
      shadow: "#1E293B", shadowStrength: 0.13,
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
    app: {
      top: "#36504B", accent: "#80FFEA",
      success: "#8AFF80", warning: "#FFFF80", danger: "#FF9580", info: "#80FFEA",
      shadow: "#000000", shadowStrength: 0.5,
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
    app: {
      top: "#4C3252", accent: "#FF80BF",
      success: "#8AFF80", warning: "#FFFF80", danger: "#FF9580", info: "#80FFEA",
      shadow: "#000000", shadowStrength: 0.5,
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
    app: {
      top: "#49463A", accent: "#FFCA80",
      success: "#8AFF80", warning: "#FFFF80", danger: "#FF9580", info: "#80FFEA",
      shadow: "#000000", shadowStrength: 0.5,
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
    app: {
      top: "#4A3234", accent: "#FF9580",
      success: "#8AFF80", warning: "#FFFF80", danger: "#FF9580", info: "#80FFEA",
      shadow: "#000000", shadowStrength: 0.5,
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
    app: {
      top: "#263340", accent: "#AA99FF",
      success: "#8AFF80", warning: "#FFFF80", danger: "#FF9580", info: "#80FFEA",
      shadow: "#000000", shadowStrength: 0.5,
    },
  },
];

export function getEditorThemeDef(id: string): EditorThemeDef | undefined {
  return EDITOR_THEMES.find((d) => d.id === id);
}

// 非 CodeMirror 場景（如 AI 助手程式碼區塊）要用的高亮色盤。
// - useBg=true：套用主題自身背景，完整重現編輯器程式碼區外觀（指定主題時）。
// - useBg=false：不覆蓋背景（維持面板底色，比照編輯器 auto 模式的 transparentBg），
//   token 色回退到符合深淺色的預設寶石盤（淺=Moonstone / 深=Amethyst）。
export interface HighlightPalette {
  colors: ThemeColors;
  useBg: boolean;
}

export function resolveHighlightColors(
  choice: EditorThemeChoice,
  appTheme: "dark" | "light",
): HighlightPalette {
  if (choice !== "auto") {
    const def = getEditorThemeDef(choice);
    if (def) return { colors: def.colors, useBg: true };
  }
  const fallback = getEditorThemeDef(appTheme === "light" ? "moonstone" : "amethyst")!;
  return { colors: fallback.colors, useBg: false };
}

// ---- 整體主題色盤推導（供 theme.ts 寫入 --c-* CSS 變數）----

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

// hex → "R G B"（供 rgb(var(--x) / <alpha>) 消費，透明度語法照常運作）。
function hexToTriple(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${r} ${g} ${b}`;
}

// 兩 hex 依比例 t(0..1) 線性內插，回傳 hex（用於生成表面景深階梯）。
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

// WCAG 相對亮度（0..1）——決定實心 accent 上該用深字或淺字。
function relLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 由變體 def 生出整套 app CSS 變數值（triple / 數值字串）。
// well/fg 沿用 colors.bg/fg；well→elevated 6 階由 mix(colors.bg → app.top) 生成，維持 db-kit 上升景深；
// on-accent 依 accent 亮度自動取對比（修「亮 accent + 白字」問題）。
export function buildAppVars(def: EditorThemeDef): Record<string, string> {
  const { colors, app } = def;
  const steps = [0, 0.22, 0.42, 0.6, 0.8, 1].map((t) => mixHex(colors.bg, app.top, t));
  const [well, inset, appc, panel, bar, elevated] = steps;
  // 實心 accent 上的文字：選與 accent 對比較高者（避免亮 accent 配白字看不清，如紫 #9580FF）。
  const contrast = (bg: string, fg: string) => {
    const a = relLuminance(bg) + 0.05;
    const b = relLuminance(fg) + 0.05;
    return a > b ? a / b : b / a;
  };
  const wantDark = app.onAccentDark ?? contrast(app.accent, "#1A1A22") >= contrast(app.accent, "#F8F8F2");
  const onAccent = wantDark ? "#1A1A22" : "#F8F8F2";
  return {
    "--c-well": hexToTriple(well),
    "--c-inset": hexToTriple(inset),
    "--c-app": hexToTriple(appc),
    "--c-panel": hexToTriple(panel),
    "--c-bar": hexToTriple(bar),
    "--c-elevated": hexToTriple(elevated),
    "--c-fg": hexToTriple(colors.fg),
    "--c-accent": hexToTriple(app.accent),
    "--c-on-accent": hexToTriple(onAccent),
    "--c-success": hexToTriple(app.success),
    "--c-warning": hexToTriple(app.warning),
    "--c-danger": hexToTriple(app.danger),
    "--c-info": hexToTriple(app.info),
    "--c-shadow": hexToTriple(app.shadow),
    "--shadow-strength": String(app.shadowStrength),
  };
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
