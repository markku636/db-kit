import { describe, expect, it } from "vitest";
import { defaultRdOptions } from "./rdTypes";
import { vncPrefsFrom, vncPrefsTo } from "./vncPrefs";

describe("vncPrefs", () => {
  it("預設：平衡畫質、不畫游標點，其他照主機設定", () => {
    const o = { ...defaultRdOptions(), resize_mode: "remote" as const, view_only: true };
    expect(vncPrefsFrom(o)).toEqual({ view: "remote", quality: "balanced", viewOnly: true, clipboard: true, dotCursor: false });
  });

  it("寫回去：檢視方式 / 只看不控制 / 剪貼簿進主機欄位，畫質與游標點進 ui，其他 ui 鍵保留", () => {
    const o = { ...defaultRdOptions(), ui: { fullscreen: "1" } };
    const out = vncPrefsTo({ view: "none", quality: "best", viewOnly: true, clipboard: false, dotCursor: true }, o);
    expect(out.resize_mode).toBe("none");
    expect(out.view_only).toBe(true);
    expect(out.clipboard).toBe(false);
    expect(out.ui).toEqual({ fullscreen: "1", vnc_quality: "best", vnc_dot_cursor: "1" });
    expect(vncPrefsFrom(out)).toEqual({ view: "none", quality: "best", viewOnly: true, clipboard: false, dotCursor: true });
  });

  it("改回預設就從 ui 拿掉", () => {
    const o = { ...defaultRdOptions(), ui: { vnc_quality: "low", vnc_dot_cursor: "1" } };
    const out = vncPrefsTo({ ...vncPrefsFrom(o), quality: "balanced", dotCursor: false }, o);
    expect(out.ui).toEqual({});
  });

  it("認不得的畫質值當平衡", () => {
    expect(vncPrefsFrom({ ...defaultRdOptions(), ui: { vnc_quality: "ultra" } }).quality).toBe("balanced");
  });
});
