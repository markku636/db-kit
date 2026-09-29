import { describe, it, expect } from "vitest";
import { EDITOR_THEMES, buildAppVars, type EditorThemeDef } from "./editorThemes";
import { SURFACE_STEPS } from "./themeSurfaces";
import { xtermThemeFor, mixHex, lightenHex, darkenHex, isDarkHex, parseHex, withAlpha, TERM_TINT } from "./sshTerminalTheme";

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
/** buildAppVars 的 --c-app（"R G B"）→ #rrggbb：查詢編輯器跟隨 App 時透出的就是這個顏色。 */
const appSurface = (def: EditorThemeDef) =>
  "#" + buildAppVars(def)["--c-app"].split(" ").map((n) => Number(n).toString(16).padStart(2, "0")).join("");
const ANSI = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

describe("xtermThemeFor", () => {
  it("每個內建變體都產出 16 色 ANSI + background/foreground/cursor，且都是合法 hex", () => {
    for (const def of EDITOR_THEMES) {
      const th = xtermThemeFor(def) as Record<string, string | undefined>;
      for (const k of [...ANSI, "background", "foreground", "cursor"]) {
        expect(th[k], `${def.id}.${k}`).toMatch(HEX);
      }
      // 底色 = app 表面（--c-app），終端機才會跟四周與查詢編輯器同色，而不是暗一截的 colors.bg。
      expect(th.background!.toLowerCase(), def.id).toBe(appSurface(def));
      expect(th.foreground).toBe(mixHex(def.colors.fg, def.app.accent, TERM_TINT.fg));
      expect(th.cursor!.toLowerCase()).toBe(def.app.accent.toLowerCase());
      expect(th.red).toBe(mixHex(def.app.danger, def.app.accent, TERM_TINT.ansi));
      expect(th.brightBlack!.toLowerCase()).toBe(def.colors.comment.toLowerCase());
      // 選取底色帶 alpha（#rrggbbaa）
      expect(th.selectionBackground).toMatch(/^#[0-9a-f]{8}$/i);
      // 深淺判定與變體宣告一致（主題定義打錯底色會在這裡露餡）
      expect(isDarkHex(th.background!), def.id).toBe(def.dark);
    }
  });

  it("bright 系列與基本色不同：深色主題提亮、淺色主題壓暗", () => {
    const dark = xtermThemeFor(EDITOR_THEMES.find((d) => d.id === "amethyst")!);
    expect(dark.brightRed).not.toBe(dark.red);
    expect(dark.brightRed).toBe(lightenHex(dark.red!, 0.15));
    const light = xtermThemeFor(EDITOR_THEMES.find((d) => d.id === "moonstone")!);
    expect(light.brightRed).toBe(darkenHex(light.red!, 0.1));
  });

  it("沒有變體（主題 id 找不到）時退回內建深色預設", () => {
    const th = xtermThemeFor(undefined);
    expect(th.background).toBe(appSurface(EDITOR_THEMES.find((d) => d.id === "amethyst")!));
    for (const k of ANSI) expect((th as Record<string, string | undefined>)[k]).toMatch(HEX);
  });

  it("色值壞掉時退回預設，不丟例外", () => {
    const def = structuredClone(EDITOR_THEMES[0]);
    def.colors.bg = "nope";
    def.colors.selection = "";
    def.app.danger = "#12";
    expect(() => xtermThemeFor(def)).not.toThrow();
    const th = xtermThemeFor(def);
    // 底色壞掉退回黑，再照常往 app.top 混出表面色。
    expect(th.background).toBe(mixHex("#000000", def.app.top, SURFACE_STEPS.app));
    expect(th.red).toBe(mixHex("#ff5555", def.app.accent, TERM_TINT.ansi));
    expect(th.selectionBackground).toBe("#00000066");
    // accent 壞掉 → 不染色，游標退回前景
    def.app.accent = "nope";
    const plain = xtermThemeFor(def);
    expect(plain.red).toBe("#ff5555");
    expect(plain.foreground).toBe(def.colors.fg.toLowerCase());
    expect(plain.cursor).toBe(plain.foreground);
  });

  // 深色變體的 fg 與語意色全都一樣，沒有往 accent 染色的話，切換主題時終端機文字色不會跟著變。
  it("每個變體的終端機文字色都不一樣（跟著主題連動）", () => {
    const keys = ["foreground", "red", "green", "blue", "magenta", "brightBlack"] as const;
    const themes = EDITOR_THEMES.map((d) => ({ id: d.id, th: xtermThemeFor(d) }));
    for (const k of keys) {
      const seen = new Map<string, string>();
      for (const { id, th } of themes) {
        const v = th[k]!.toLowerCase();
        expect(seen.get(v), `${k}: ${id} 與 ${seen.get(v)} 同色`).toBeUndefined();
        seen.set(v, id);
      }
    }
  });

  // 底色（app 表面）本身比 well 亮，少數變體的語意色不染色就不到 4.5:1（如 Amethyst 的 blue 4.24）——
  // 染色不能是讓它更差的那一步：原本 ≥ 4.5 的不掉到 4.5 以下，原本不到的不再往下掉。
  it("染色不降低可讀性；brightBlack 改用 comment 比原本的 activeLine 提亮更好讀", () => {
    const lum = (hex: string) => {
      const c = parseHex(hex)!;
      const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const def of EDITOR_THEMES) {
      const th = xtermThemeFor(def) as Record<string, string>;
      // accent 壞掉 = 不染色；底色與 ANSI 來源都相同，只差染色這一步。
      const raw = xtermThemeFor({ ...def, app: { ...def.app, accent: "nope" } }) as Record<string, string>;
      for (const k of ["foreground", "red", "green", "yellow", "blue", "magenta", "cyan"]) {
        const floor = Math.min(4.5, ratio(raw[k], th.background)) - 1e-9;
        expect(ratio(th[k], th.background), `${def.id}.${k}`).toBeGreaterThanOrEqual(floor);
      }
      const oldDim = def.dark ? lightenHex(th.black, 0.15) : darkenHex(th.black, 0.1);
      expect(ratio(th.brightBlack, th.background), `${def.id}.brightBlack`).toBeGreaterThan(ratio(oldDim, th.background));
    }
  });
});

describe("色彩工具", () => {
  it("parseHex 接受 #rgb / #rrggbb / #rrggbbaa，其他回 null", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("22212C")).toEqual({ r: 0x22, g: 0x21, b: 0x2c });
    expect(parseHex("#22212Cff")).toEqual({ r: 0x22, g: 0x21, b: 0x2c });
    for (const bad of ["", "#", "#12", "#12345", "red", null, 3, undefined]) expect(parseHex(bad)).toBeNull();
  });

  it("mixHex 線性內插並夾在 0..1；一邊壞掉回另一邊", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 5)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", Number.NaN)).toBe("#000000");
    // 注意 "bad" 本身是合法的 #rgb（b/a/d 都是 hex 位數），壞值要用真的壞值
    expect(mixHex("nope", "#ffffff", 0.5)).toBe("#ffffff");
    expect(mixHex("#ffffff", "nope", 0.5)).toBe("#ffffff");
    expect(mixHex("nope", "worse", 0.5)).toBe("#000000");
  });

  it("lighten / darken / withAlpha", () => {
    expect(lightenHex("#000000", 0.5)).toBe("#808080");
    expect(darkenHex("#ffffff", 0.5)).toBe("#808080");
    expect(lightenHex("#abc", 0)).toBe("#aabbcc");
    expect(withAlpha("#736C93", "66")).toBe("#736c9366");
    expect(withAlpha("#736C93aa", "66")).toBe("#736c9366");
  });

  it("isDarkHex：深底 / 淺底 / 壞值", () => {
    expect(isDarkHex("#22212C")).toBe(true);
    expect(isDarkHex("#000")).toBe(true);
    expect(isDarkHex("#ECECF3")).toBe(false);
    expect(isDarkHex("#fff")).toBe(false);
    expect(isDarkHex("nope")).toBe(true);
  });
});
