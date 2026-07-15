import { useMemo, useRef, useState } from "react";
import { useT } from "../i18n";

export interface TsPoint { t: number; v: number }

// 手刻 SVG 時間序列折線 / 面積圖（單序列）。用 app 主題 accent 色（currentColor），無依賴。
// x=時間、y=值；hover 顯示最接近點的值與時間。responsive：viewBox + width:100%。
export default function TimeSeriesChart({
  points,
  height = 120,
  label,
  color = "currentColor",
  formatValue = (v) => String(v),
}: {
  points: TsPoint[];
  height?: number;
  label?: string;
  color?: string;
  formatValue?: (v: number) => string;
}) {
  const t = useT();
  const W = 600;
  const H = height;
  const PAD = 6;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);

  const { areaD, lineD, min, max, xs } = useMemo(() => {
    if (points.length < 2) return { areaD: "", lineD: "", min: 0, max: 0, xs: [] as number[] };
    const vs = points.map((p) => p.v);
    const min = Math.min(...vs);
    const max = Math.max(...vs);
    const span = max - min || 1;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const tspan = t1 - t0 || 1;
    const xs = points.map((p) => PAD + ((p.t - t0) / tspan) * (W - 2 * PAD));
    const ys = points.map((p) => H - PAD - ((p.v - min) / span) * (H - 2 * PAD));
    const line = points.map((_, i) => `${i === 0 ? "M" : "L"}${xs[i].toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
    const area = `${line} L${xs[xs.length - 1].toFixed(1)},${H - PAD} L${xs[0].toFixed(1)},${H - PAD} Z`;
    return { areaD: area, lineD: line, min, max, xs };
  }, [points, H]);

  if (points.length < 2) {
    return <div className="h-[120px] flex items-center justify-center text-fg/25 text-xs">{label ? `${label} · ` : ""}{t("資料不足")}</div>;
  }

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    // 找最接近的 x。
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - px);
      if (d < bd) { bd = d; best = i; }
    }
    setHover({ i: best, x: xs[best] });
  };

  const hp = hover ? points[hover.i] : null;

  return (
    <div className="relative" style={{ color }}>
      {label && <div className="text-fg/40 text-[10px] mb-0.5">{label}</div>}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full block"
        style={{ height: H }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <path d={areaD} fill="currentColor" opacity={0.1} />
        <path d={lineD} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        {hover && (
          <line x1={hover.x} y1={PAD} x2={hover.x} y2={H - PAD} stroke="currentColor" strokeWidth={0.75} opacity={0.4} />
        )}
      </svg>
      {/* y 軸極值 */}
      <div className="absolute top-0 right-0 text-fg/30 text-[9px] mono">{formatValue(max)}</div>
      <div className="absolute bottom-0 right-0 text-fg/30 text-[9px] mono">{formatValue(min)}</div>
      {hp && (
        <div className="absolute top-0 left-0 text-fg/60 text-[10px] mono bg-elevated/90 px-1 rounded pointer-events-none">
          {formatValue(hp.v)} · {new Date(hp.t).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
