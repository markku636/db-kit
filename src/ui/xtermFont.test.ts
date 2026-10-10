import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { remeasureWhenFontLoads, TERM_FONT } from "./xtermFont";

function fakeTerm() {
  const options: { fontSize?: number; fontFamily?: string } = { fontSize: 14, fontFamily: TERM_FONT };
  const term = { options, clearTextureAtlas: vi.fn() };
  return { term, asTerm: term as unknown as Terminal };
}

function stubFonts(checkSays: boolean) {
  let resolve!: () => void;
  const pending = new Promise<void>((r) => { resolve = () => r(); });
  const fonts = { check: vi.fn(() => checkSays), load: vi.fn(() => pending) };
  vi.stubGlobal("document", { fonts });
  return { fonts, finishLoading: async () => { resolve(); await pending; await Promise.resolve(); } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("TERM_FONT", () => {
  it("第一個字型就是 fonts.css 內嵌註冊的名字（不靠系統有沒有裝）", () => {
    const css = readFileSync(new URL("../fonts.css", import.meta.url), "utf8");
    expect(css).toContain("font-family: 'JetBrains Mono Variable'");
    expect(TERM_FONT.startsWith('"JetBrains Mono Variable",')).toBe(true);
  });
});

describe("remeasureWhenFontLoads", () => {
  it("字型已載好也照樣重量一次（WebKit 的 fonts.check() 不可靠，不靠它跳過）", async () => {
    const { fonts, finishLoading } = stubFonts(true);
    const { term, asTerm } = fakeTerm();
    const cb = vi.fn();
    remeasureWhenFontLoads(asTerm, cb);
    expect(fonts.load).toHaveBeenCalledWith('14px "JetBrains Mono Variable"');
    await finishLoading();
    expect(term.options.fontFamily?.trim()).toBe(TERM_FONT);
    expect(cb).toHaveBeenCalledOnce();
  });

  it("字型晚到：換一個等價的字型字串觸發重量、清字形快取、通知呼叫端", async () => {
    const { finishLoading } = stubFonts(false);
    const { term, asTerm } = fakeTerm();
    const cb = vi.fn();
    remeasureWhenFontLoads(asTerm, cb);
    expect(cb).not.toHaveBeenCalled();
    await finishLoading();
    expect(term.options.fontFamily).not.toBe(TERM_FONT);
    expect(term.options.fontFamily?.trim()).toBe(TERM_FONT);
    expect(term.clearTextureAtlas).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledOnce();
  });

  it("卸載後字型才到：不再碰已經關掉的終端", async () => {
    const { finishLoading } = stubFonts(false);
    const { term, asTerm } = fakeTerm();
    const cb = vi.fn();
    const stop = remeasureWhenFontLoads(asTerm, cb);
    stop();
    await finishLoading();
    expect(term.options.fontFamily).toBe(TERM_FONT);
    expect(term.clearTextureAtlas).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
  });

  it("沒有 document（非瀏覽器）：直接略過", () => {
    vi.stubGlobal("document", undefined);
    const { asTerm } = fakeTerm();
    expect(() => remeasureWhenFontLoads(asTerm, vi.fn())()).not.toThrow();
  });
});
