// 極簡內嵌折線（無座標軸），供清單列旁顯示趨勢。純 SVG、無依賴、用 currentColor 上色。
export default function Sparkline({ points, width = 80, height = 20, className = "" }: {
  points: number[]; width?: number; height?: number; className?: string;
}) {
  if (points.length < 2) return <svg width={width} height={height} className={className} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const dx = width / (points.length - 1);
  const d = points
    .map((v, i) => {
      const x = i * dx;
      const y = height - ((v - min) / span) * (height - 2) - 1;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} className={className} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
