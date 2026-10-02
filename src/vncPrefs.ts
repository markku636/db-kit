// VNC 工具列的顯示偏好：檢視方式 / 只看不控制 / 同步剪貼簿直接用主機設定的欄位（跟主機對話框改的是同一份），
// 畫質與「顯示游標點」存在 options.ui（前端自己的偏好，後端只存）。純邏輯，單元測試用。
import type { RdOptions, RdResizeMode } from "./rdTypes";

/** 畫質（noVNC 的 JPEG 品質 / 壓縮等級；只有 Tight 這類編碼用得到，伺服器不支援就沒差）。 */
export type VncQuality = "best" | "balanced" | "low";

export interface VncPrefs {
  view: RdResizeMode;
  quality: VncQuality;
  viewOnly: boolean;
  clipboard: boolean;
  /** 遠端沒送游標形狀（或游標是透明的）時，在滑鼠位置畫一個小點。 */
  dotCursor: boolean;
}

/**
 * 畫質 → [JPEG 品質 0–9, 壓縮等級 0–9]。平衡 = noVNC 的預設（6 / 2）；
 * 最佳畫質 = JPEG 幾乎不失真、少壓縮（區網）；最佳反應速度 = 畫質降低、壓到最小（慢的網路）。
 */
export const VNC_QUALITY_LEVELS: Record<VncQuality, [number, number]> = {
  best: [9, 1],
  balanced: [6, 2],
  low: [2, 9],
};

const UI_QUALITY = "vnc_quality";
const UI_DOT = "vnc_dot_cursor";

export function vncPrefsFrom(o: RdOptions): VncPrefs {
  const q = o.ui?.[UI_QUALITY];
  return {
    view: o.resize_mode,
    quality: q === "best" || q === "low" ? q : "balanced",
    viewOnly: o.view_only,
    clipboard: o.clipboard,
    dotCursor: o.ui?.[UI_DOT] === "1",
  };
}

/** 寫回主機設定（options.ui 只留跟預設不一樣的）。 */
export function vncPrefsTo(p: VncPrefs, o: RdOptions): RdOptions {
  const ui = { ...(o.ui ?? {}) };
  if (p.quality === "balanced") delete ui[UI_QUALITY];
  else ui[UI_QUALITY] = p.quality;
  if (p.dotCursor) ui[UI_DOT] = "1";
  else delete ui[UI_DOT];
  return { ...o, resize_mode: p.view, view_only: p.viewOnly, clipboard: p.clipboard, ui };
}
