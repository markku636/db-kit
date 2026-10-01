import { describe, it, expect } from "vitest";
import { EDITOR_THEMES, buildAppVars, type EditorThemeDef } from "./editorThemes";
import { SURFACE_STEPS } from "./themeSurfaces";
import { xtermThemeFor, mixHex, lightenHex, darkenHex, isDarkHex, parseHex, withAlpha, TERM_PALETTES } from "./sshTerminalTheme";

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
/** buildAppVars 的 --c-app（"R G B"）→ #rrggbb：查詢編輯器跟隨 App 時透出的就是這個顏色。 */
const appSurface = (def: EditorThemeDef) =>
  "#" + buildAppVars(def)["--c-app"].split(" ").map((n) => Number(n).toString(16).padStart(2, "0")).join("");
const ANSI = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
const def = (id: string) => EDITOR_THEMES.find((d) => d.id === id)!;

describe("xtermThemeFor", () => {
  it("每個內建變體都產出 16 色 ANSI + background/foreground/cursor，且都是合法 hex", () => {
    for (const d of EDITOR_THEMES) {
      const th = xtermThemeFor(d) as Record<string, string | undefined>;
      for (const k of [...ANSI, "background", "foreground", "cursor"]) {
        expect(th[k], `${d.id}.${k}`).toMatch(HEX);
      }
      // 底色 = app 表面（--c-app），終端機才會跟四周與查詢編輯器同色，而不是暗一截的 colors.bg。
      expect(th.background!.toLowerCase(), d.id).toBe(appSurface(d));
      expect(th.cursor!.toLowerCase()).toBe(d.app.accent.toLowerCase());
      expect(th.black!.toLowerCase()).toBe(d.colors.bg.toLowerCase());
      expect(th.brightBlack!.toLowerCase()).toBe(d.colors.comment.toLowerCase());
      // 選取底色帶 alpha（#rrggbbaa）
      expect(th.selectionBackground).toMatch(/^#[0-9a-f]{8}$/i);
      // 深淺判定與變體宣告一致（主題定義打錯底色會在這裡露餡）
      expect(isDarkHex(th.background!), d.id).toBe(d.dark);
    }
  });

  it("文字色照抄該變體的終端機配色，不自行推導", () => {
    for (const d of EDITOR_THEMES) {
      const th = xtermThemeFor(d) as Record<string, string | undefined>;
      const pal = TERM_PALETTES[d.id];
      for (const [k, v] of Object.entries(pal)) {
        expect(v, `${d.id}.${k}`).toMatch(HEX);
        expect(th[k], `${d.id}.${k}`).toBe(v);
      }
      // 配色表的前景與 white 跟主題本身的前景一致（淺色那組的 white 是深色前景）。
      expect(pal.foreground.toLowerCase(), d.id).toBe(d.colors.fg.toLowerCase());
      expect(pal.white, d.id).toBe(pal.foreground);
    }
  });

  // 深色變體的文字色是同一組，切換時跟著換的是底色、淡字灰、black 與游標；淺色變體整組文字色都不同。
  it("切換主題時終端機配色跟著變", () => {
    const keys = ["background", "black", "brightBlack"] as const;
    const themes = EDITOR_THEMES.map((d) => ({ id: d.id, th: xtermThemeFor(d) }));
    for (const k of keys) {
      const seen = new Map<string, string>();
      for (const { id, th } of themes) {
        const v = th[k]!.toLowerCase();
        expect(seen.get(v), `${k}: ${id} 與 ${seen.get(v)} 同色`).toBeUndefined();
        seen.set(v, id);
      }
    }
    const dark = xtermThemeFor(def("amethyst"));
    const light = xtermThemeFor(def("moonstone"));
    for (const k of ["foreground", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightWhite"] as const) {
      expect(light[k], k).not.toBe(dark[k]);
    }
  });

  it("沒有變體（主題 id 找不到）時退回內建深色預設；配色表沒有的 id 依深淺取同類那組", () => {
    const th = xtermThemeFor(undefined);
    expect(th.background).toBe(appSurface(def("amethyst")));
    expect(th.red).toBe(TERM_PALETTES.amethyst.red);
    for (const k of ANSI) expect((th as Record<string, string | undefined>)[k]).toMatch(HEX);
    const custom = { ...def("moonstone"), id: "nope" } as unknown as EditorThemeDef;
    expect(xtermThemeFor(custom).red).toBe(TERM_PALETTES.moonstone.red);
    const customDark = { ...def("jade"), id: "nope" } as unknown as EditorThemeDef;
    expect(xtermThemeFor(customDark).red).toBe(TERM_PALETTES.jade.red);
  });

  it("色值壞掉時退回預設，不丟例外", () => {
    const d = structuredClone(EDITOR_THEMES[0]);
    d.colors.bg = "nope";
    d.colors.selection = "";
    d.colors.comment = "#12";
    expect(() => xtermThemeFor(d)).not.toThrow();
    const th = xtermThemeFor(d);
    // 底色壞掉退回黑，再照常往 app.top 混出表面色。
    expect(th.background).toBe(mixHex("#000000", d.app.top, SURFACE_STEPS.app));
    expect(th.black).toBe("#000000");
    expect(th.selectionBackground).toBe("#00000066");
    // comment 壞掉 → 淡字灰取前景與底色的中間值
    expect(th.brightBlack).toBe(mixHex(th.foreground!, th.background!, 0.5));
    // accent 壞掉 → 游標退回前景
    d.app.accent = "nope";
    expect(xtermThemeFor(d).cursor).toBe(th.foreground);
  });

  // 底色（app 表面）比配色檔原本的底色亮一階，所以這裡在實際底色上量：
  // 每個文字色至少 3:1；淡字灰（app 自己的 \x1b[90m 提示）用 comment，至少 2.5:1。
  it("文字色在終端機底色上讀得出來", () => {
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
    for (const d of EDITOR_THEMES) {
      const th = xtermThemeFor(d) as Record<string, string>;
      for (const k of Object.keys(TERM_PALETTES[d.id])) {
        expect(ratio(th[k], th.background), `${d.id}.${k}`).toBeGreaterThanOrEqual(3);
      }
      expect(ratio(th.brightBlack, th.background), `${d.id}.brightBlack`).toBeGreaterThanOrEqual(2.5);
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
