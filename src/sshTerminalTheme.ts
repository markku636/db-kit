import type { ITheme } from "@xterm/xterm";
import type { EditorThemeDef, EditorThemeId } from "./editorThemes";
import { SURFACE_STEPS } from "./themeSurfaces";

// xterm 主題跟隨 useTheme 切換：文字色取各變體配套的終端機配色（TERM_PALETTES），其餘由 app 變體推導。
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

/** 終端機文字色：預設前景 + ANSI 中會拿來印字的 15 色（black 與 brightBlack 由變體推導，見 xtermThemeFor）。 */
export type TermTextColors = Required<
  Pick<
    ITheme,
    | "foreground" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
    | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite"
  >
>;

// 色值照抄各變體配套的終端機配色檔，不自行推導或往 accent 染色——ls / git / htop 印出來的顏色就是那套配色原本的樣子。
// 配色檔裡六個深色變體的文字色是同一組，差在底色、游標、選取與淡字灰；淺色變體自成一組。
const DARK_TEXT: TermTextColors = {
  foreground: "#F8F8F2",
  red: "#FF9580", green: "#8AFF80", yellow: "#FFFF80", blue: "#9580FF",
  magenta: "#FF80BF", cyan: "#80FFEA", white: "#F8F8F2",
  brightRed: "#FFAA99", brightGreen: "#A2FF99", brightYellow: "#FFFF99", brightBlue: "#AA99FF",
  brightMagenta: "#FF99CC", brightCyan: "#99FFEE", brightWhite: "#FFFFFF",
};

// 淺色配色把 white 定成深色前景：多數 CLI 假設深底、直接印「白字」，在淺底上照樣看得到。
const LIGHT_TEXT: TermTextColors = {
  foreground: "#1F1F1F",
  red: "#CB3A2A", green: "#14710A", yellow: "#846E15", blue: "#644AC9",
  magenta: "#A3144D", cyan: "#036A96", white: "#1F1F1F",
  brightRed: "#D74C3D", brightGreen: "#198D0C", brightYellow: "#9E841A", brightBlue: "#7862D0",
  brightMagenta: "#BF185A", brightCyan: "#047FB4", brightWhite: "#2C2B31",
};

/** 每個變體的終端機文字色。用 Record<EditorThemeId> 是為了新增變體時漏配會直接編譯失敗。 */
export const TERM_PALETTES: Record<EditorThemeId, TermTextColors> = {
  amethyst: DARK_TEXT,
  moonstone: LIGHT_TEXT,
  jade: DARK_TEXT,
  garnet: DARK_TEXT,
  amber: DARK_TEXT,
  ruby: DARK_TEXT,
  obsidian: DARK_TEXT,
};

/**
 * app 變體 → xterm ITheme。def 為空（主題 id 對不上）就用內建深色預設，呼叫端可直接餵 getEditorThemeDef(id)。
 * - 文字色（前景與 15 個 ANSI 色）查 TERM_PALETTES；id 不在表上（自訂 def）就依深淺取同類那組。
 * - background = app 表面（mix(colors.bg → app.top, SURFACE_STEPS.app)，與 --c-app / 查詢編輯器同色）；
 *   cursor = accent；selection 加 40% alpha 當選取底色。
 * - black = colors.bg：配色檔的 black 就是它自己的底色（深色變體與 colors.bg 同值），
 *   在略亮的 app 表面上當 ESC[40m 底色是一道淺淺的凹槽。
 * - brightBlack = comment：配色檔的淡字灰在 app 表面上不到 2:1（淺色那組甚至是純白），
 *   而 app 自己印的 \x1b[90m 提示就用這個色，所以換成變體自家色調、讀得出來的 comment 灰。
 */
export function xtermThemeFor(def: EditorThemeDef | null | undefined): ITheme {
  const { id, colors, app, dark } = def ?? FALLBACK_DEF;
  const norm = (c: string, fallback: string) => {
    const p = parseHex(c);
    return p ? toHex(p) : fallback;
  };
  const text = TERM_PALETTES[id] ?? (dark ? DARK_TEXT : LIGHT_TEXT);
  const well = norm(colors.bg, dark ? "#000000" : "#ffffff");
  const bg = mixHex(well, norm(app.top, well), SURFACE_STEPS.app);
  return {
    ...text,
    background: bg,
    cursor: norm(app.accent, text.foreground),
    cursorAccent: bg,
    selectionBackground: withAlpha(colors.selection, "66"),
    selectionInactiveBackground: withAlpha(colors.selection, "40"),
    black: well,
    brightBlack: norm(colors.comment, mixHex(text.foreground, bg, 0.5)),
  };
}
