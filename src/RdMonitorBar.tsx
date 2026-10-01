// 遠端桌面工具列的「切換螢幕」：對方有好幾個螢幕時，每個螢幕一顆按鈕（螢幕圖示裡是編號，正在看的標亮），
// 再加一顆「所有螢幕」（圖示照對方螢幕的實際排列畫）。照 RustDesk 官方用戶端工具列的螢幕按鈕。
import { useT } from "./i18n";
import { allDisplays, canShowAll, miniLayout, showingAll, type RdDisplay, type RdMonitors } from "./rdMonitors";

const BTN = "w-7 h-7 grid place-items-center rounded shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-accent/60 ";
const ON = "bg-accent/12 text-accent";
const OFF = "text-fg/55 hover:text-fg hover:bg-fg/10 active:bg-fg/[0.14]";

/** 螢幕（外框 + 底座），中間是編號。 */
function MonitorGlyph({ n }: { n: number }) {
  return (
    <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden>
      <rect x="1" y="1" width="16" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.5 15h5M9 12v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <text x="9" y="6.9" textAnchor="middle" dominantBaseline="central" fontSize="7.5" fontWeight="700" fill="currentColor">{n}</text>
    </svg>
  );
}

/** 所有螢幕：每個螢幕照實際位置大小縮小畫出來。 */
function AllGlyph({ displays }: { displays: RdDisplay[] }) {
  return (
    <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden>
      {miniLayout(displays, 16, 12, 1.4).map((r, i) => (
        <rect key={i} x={1 + r.x} y={2 + r.y} width={r.w} height={r.h} rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
      ))}
    </svg>
  );
}

export default function RdMonitorBar({ monitors, onPick }: { monitors: RdMonitors; onPick: (set: number[]) => void }) {
  const t = useT();
  const all = showingAll(monitors);
  return (
    <div role="group" aria-label={t("切換螢幕")} className="flex items-center gap-0.5 shrink-0" data-rd-monitors="">
      {monitors.displays.map((d, i) => {
        const on = !all && monitors.shown[0] === i;
        const label = d.width > 0 && d.height > 0
          ? t("螢幕 {n}（{w}×{h}）", { n: i + 1, w: d.width, h: d.height })
          : t("螢幕 {n}", { n: i + 1 });
        return (
          <button key={i} type="button" className={BTN + (on ? ON : OFF)} aria-label={label} title={label} aria-pressed={on}
            data-rd-monitor={i} onClick={() => onPick([i])}>
            <MonitorGlyph n={i + 1} />
          </button>
        );
      })}
      {canShowAll(monitors) && (
        <button type="button" className={BTN + (all ? ON : OFF)} aria-label={t("所有螢幕")} title={t("所有螢幕")} aria-pressed={all}
          data-rd-monitor="all" onClick={() => onPick(allDisplays(monitors))}>
          <AllGlyph displays={monitors.displays} />
        </button>
      )}
      <span className="w-px h-4 bg-fg/15 mx-1" aria-hidden />
    </div>
  );
}
