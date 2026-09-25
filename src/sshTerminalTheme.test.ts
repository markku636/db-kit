import { describe, it, expect } from "vitest";
import { EDITOR_THEMES } from "./editorThemes";
import { xtermThemeFor, mixHex, lightenHex, darkenHex, isDarkHex, parseHex, withAlpha } from "./sshTerminalTheme";

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
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
      expect(th.background!.toLowerCase()).toBe(def.colors.bg.toLowerCase());
      expect(th.foreground!.toLowerCase()).toBe(def.colors.fg.toLowerCase());
      expect(th.cursor!.toLowerCase()).toBe(def.colors.caret.toLowerCase());
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
    expect(th.background).toBe("#22212c");
    for (const k of ANSI) expect((th as Record<string, string | undefined>)[k]).toMatch(HEX);
  });

  it("色值壞掉時退回預設，不丟例外", () => {
    const def = structuredClone(EDITOR_THEMES[0]);
    def.colors.bg = "nope";
    def.colors.selection = "";
    def.app.danger = "#12";
    expect(() => xtermThemeFor(def)).not.toThrow();
    const th = xtermThemeFor(def);
    expect(th.background).toBe("#000000");
    expect(th.red).toBe("#ff5555");
    expect(th.selectionBackground).toBe("#00000066");
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
