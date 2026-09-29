import type { ITheme } from "@xterm/xterm";
import type { EditorThemeDef } from "./editorThemes";
import { SURFACE_STEPS } from "./themeSurfaces";

// xterm 主題由 app 變體（editorThemes）推導，跟隨 useTheme 切換，不另外維護一套終端配色。
// 底色取 app 表面（--c-app），不是 colors.bg：後者是最深的 well 階，終端機會比四周與查詢編輯器暗一截。
// 只 `import type`：這支被純邏輯測試載入，不能把 xterm 本體拖進來。
// 所有 hex 處理都走 parseHex 做退路——主題定義是人手抄的，一個打錯的色值不該讓終端機開不起來。

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 解析 #rgb / #rrggbb / #rrggbbaa（有無 # 皆可，alpha 捨棄）；壞值回 null，絕不丟例外。 */
export function parseHex(hex: unknown): Rgb | null {
  if (typeof hex !== "string") return null;
  const h = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  if (/^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(h)) {
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  return null;
}

const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");

function toHex(c: Rgb): string {
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}`;
}

/** a → b 依 t (0..1) 線性內插，回 #rrggbb。任一邊壞掉就回另一邊；都壞回黑。 */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa && !pb) return "#000000";
  if (!pa) return toHex(pb!);
  if (!pb) return toHex(pa);
  const k = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  return toHex({ r: pa.r + (pb.r - pa.r) * k, g: pa.g + (pb.g - pa.g) * k, b: pa.b + (pb.b - pa.b) * k });
}

/** 往白提亮 amount (0..1)。 */
export function lightenHex(hex: string, amount: number): string {
  return mixHex(hex, "#ffffff", amount);
}

/** 往黑壓暗 amount (0..1)。 */
export function darkenHex(hex: string, amount: number): string {
  return mixHex(hex, "#000000", amount);
}

/** WCAG 相對亮度 < 0.5 視為深色；壞值當深色（終端預設就是深底）。 */
export function isDarkHex(hex: string): boolean {
  const c = parseHex(hex);
  if (!c) return true;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b) < 0.5;
}

/** 合成 #rrggbbaa（alphaHex 為兩位 hex，如 "66" ≈ 40%）。來源壞掉退回黑 + alpha。 */
export function withAlpha(hex: string, alphaHex: string): string {
  const c = parseHex(hex);
  return `${c ? toHex(c) : "#000000"}${alphaHex}`;
}

// getEditorThemeDef 找不到 id 時的退路（= Amethyst）。用 inline 字面值而不是 import EDITOR_THEMES：
// 本模組維持只 `import type`，不把 editorThemes 連帶的 CodeMirror 拖進純邏輯 chunk。
const FALLBACK_DEF: EditorThemeDef = {
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
};

/**
 * 終端機文字往主題 accent 靠的比例（ANSI 彩色 / 預設前景）。
 * 深色變體共用同一組語意色（danger / success / warning / info）與 fg、keyword、number，
 * 不染色的話切換深色主題時終端機文字一模一樣，只有底色在變。30% / 12% 下每個變體都明顯帶自家色調，
 * 而染色不會讓任何一個顏色更難讀：原本對底色 ≥ 4.5:1 的仍 ≥ 4.5:1，不到的也不再往下掉
 * （accent 偏亮，多數還會變好讀；見 sshTerminalTheme.test.ts）。
 */
export const TERM_TINT = { ansi: 0.3, fg: 0.12 } as const;

/**
 * app 變體 → xterm ITheme。def 為空（主題 id 對不上）就用內建深色預設，呼叫端可直接餵 getEditorThemeDef(id)。
 * - background = app 表面（mix(colors.bg → app.top, SURFACE_STEPS.app)，與 --c-app / 查詢編輯器同色）；
 *   foreground = fg 往 accent 染 12%；cursor = accent；selection 加 40% alpha 當選取底色。
 * - ANSI 16 色：black=activeLine、red=danger、green=success、yellow=warning、blue=number、
 *   magenta=keyword、cyan=info，六個彩色各往 accent 染 30%；white=前景；brightBlack=comment
 *   （變體自家色調的灰，也是 app 自己印的 \x1b[90m 提示用色）；其餘 bright 系列深色主題往白提 15%、
 *   淺色主題往黑壓 10%。white=前景的用意是「程式印白字時在淺色主題仍看得到」（多數 CLI 假設深底），
 *   代價是淺色主題下顯式的 ANSI black 會很淡——實務上幾乎沒有程式主動印黑字。
 * - accent 壞掉時 mixHex 回原色，等於不染色；游標退回前景。
 */
export function xtermThemeFor(def: EditorThemeDef | null | undefined): ITheme {
  const { colors, app, dark } = def ?? FALLBACK_DEF;
  const fbBg = dark ? "#000000" : "#ffffff";
  const fbFg = dark ? "#ffffff" : "#000000";
  const norm = (c: string, fallback: string) => {
    const p = parseHex(c);
    return p ? toHex(p) : fallback;
  };
  const bright = (c: string) => (dark ? lightenHex(c, 0.15) : darkenHex(c, 0.1));
  const tint = (c: string, k: number) => mixHex(c, app.accent, k);
  const well = norm(colors.bg, fbBg);
  const bg = mixHex(well, norm(app.top, well), SURFACE_STEPS.app);
  const fg = tint(norm(colors.fg, fbFg), TERM_TINT.fg);
  const base = {
    black: norm(colors.activeLine, dark ? "#444444" : "#bbbbbb"),
    red: tint(norm(app.danger, "#ff5555"), TERM_TINT.ansi),
    green: tint(norm(app.success, "#50fa7b"), TERM_TINT.ansi),
    yellow: tint(norm(app.warning, "#f1fa8c"), TERM_TINT.ansi),
    blue: tint(norm(colors.number, "#8be9fd"), TERM_TINT.ansi),
    magenta: tint(norm(colors.keyword, "#ff79c6"), TERM_TINT.ansi),
    cyan: tint(norm(app.info, "#8be9fd"), TERM_TINT.ansi),
    white: fg,
  };
  return {
    background: bg,
    foreground: fg,
    cursor: norm(app.accent, fg),
    cursorAccent: bg,
    selectionBackground: withAlpha(colors.selection, "66"),
    selectionInactiveBackground: withAlpha(colors.selection, "40"),
    ...base,
    brightBlack: norm(colors.comment, bright(base.black)),
    brightRed: bright(base.red),
    brightGreen: bright(base.green),
    brightYellow: bright(base.yellow),
    brightBlue: bright(base.blue),
    brightMagenta: bright(base.magenta),
    brightCyan: bright(base.cyan),
    brightWhite: bright(base.white),
  };
}
