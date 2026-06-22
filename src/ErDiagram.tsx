import { useEffect, useRef, useState } from "react";
import { api, ErModel, ErTable } from "./api";

const CARD_W = 210;
const CANVAS_W = 2400;
const CANVAS_H = 1600;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2;

export default function ErDiagram({ connId, onClose }: { connId: string; onClose: () => void }) {
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState("");
  const [model, setModel] = useState<ErModel | null>(null);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  // 進行中拖曳的監聽卸載函式；卸載時用來移除 window 監聽，避免洩漏。
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  const layoutKey = `er-pos:${connId}:${db}`;

  useEffect(() => {
    api
      .listDatabases(connId)
      .then((d) => { setDbs(d); setDb((cur) => cur || d[0] || ""); })
      .catch((e) => setErr(e?.message ?? "讀取資料庫失敗"));
  }, [connId]);

  // 預設網格佈局；若 localStorage 有此 DB 的存檔位置則覆蓋（拖曳後的佈局可保留）。
  const gridLayout = (m: ErModel): Record<string, { x: number; y: number }> => {
    const p: Record<string, { x: number; y: number }> = {};
    m.tables.forEach((t, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      p[t.name] = { x: 24 + col * (CARD_W + 60), y: 24 + row * 250 };
    });
    return p;
  };

  useEffect(() => {
    if (!db) return;
    // 防競態：快速切換 DB 時，較早的回應若晚到不可覆蓋目前的 model/pos。
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .erModel(connId, db)
      .then((m) => {
        if (cancelled) return;
        setModel(m);
        const base = gridLayout(m);
        try {
          const saved = JSON.parse(localStorage.getItem(layoutKey) || "{}");
          for (const t of m.tables) {
            if (saved[t.name] && typeof saved[t.name].x === "number") base[t.name] = saved[t.name];
          }
        } catch {
          /* 忽略損毀的存檔 */
        }
        setPos(base);
      })
      .catch((e) => { if (!cancelled) { setErr(e?.message ?? "讀取 ER 失敗"); setModel(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db]);

  const tableByName = (n: string) => model?.tables.find((t) => t.name === n);
  const cardH = (t: ErTable) => 26 + t.columns.length * 20 + 4;
  const center = (name: string) => {
    const t = tableByName(name);
    const p = pos[name];
    if (!t || !p) return null;
    return { x: p.x + CARD_W / 2, y: p.y + cardH(t) / 2 };
  };

  const savePos = (p: Record<string, { x: number; y: number }>) => {
    try {
      localStorage.setItem(layoutKey, JSON.stringify(p));
    } catch {
      /* 忽略寫入失敗 */
    }
  };

  const startDrag = (name: string, e: React.PointerEvent) => {
    e.preventDefault();
    const start = pos[name] ?? { x: 0, y: 0 };
    const sx = e.clientX;
    const sy = e.clientY;
    const z = zoom; // 拖曳期間以起始縮放換算位移
    let latest = start;
    const onMove = (ev: PointerEvent) => {
      latest = { x: start.x + (ev.clientX - sx) / z, y: start.y + (ev.clientY - sy) / z };
      setPos((p) => ({ ...p, [name]: latest }));
    };
    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dragCleanup.current = null;
    };
    const onUp = () => {
      detach();
      setPos((p) => { const next = { ...p, [name]: latest }; savePos(next); return next; });
    };
    // 記住卸載函式：若拖曳期間元件卸載（關閉對話框），用 effect cleanup 移除監聽，避免洩漏 / 卸載後 setState。
    dragCleanup.current = detach;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const resetLayout = () => {
    if (!model) return;
    const base = gridLayout(model);
    setPos(base);
    savePos(base);
    setZoom(1);
  };

  // 依目前佈局的邊界框，縮放到剛好塞進可視區。
  const fit = () => {
    if (!model || !viewRef.current) return;
    let maxX = 1;
    let maxY = 1;
    for (const t of model.tables) {
      const p = pos[t.name];
      if (!p) continue;
      maxX = Math.max(maxX, p.x + CARD_W);
      maxY = Math.max(maxY, p.y + cardH(t));
    }
    const vw = viewRef.current.clientWidth - 48;
    const vh = viewRef.current.clientHeight - 48;
    const z = Math.min(1, vw / maxX, vh / maxY);
    setZoom(Math.max(ZOOM_MIN, +z.toFixed(2)));
  };

  const bump = (delta: number) =>
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + delta).toFixed(2))));

  // 該關聯是否與目前 hover 的表卡相連（用於高亮）。
  const relatedToHover = (fromT: string, toT: string) =>
    hovered != null && (hovered === fromT || hovered === toT);

  const zbtn = "px-2 py-0.5 rounded border border-white/15 hover:bg-white/10 text-white/70 text-xs";

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#11161d] w-[92vw] h-[88vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-2 border-b border-white/10 flex items-center gap-3 text-sm">
          <span className="font-medium">ER 圖</span>
          <select value={db} onChange={(e) => setDb(e.target.value)} title="選擇資料庫 / schema"
            className="bg-black/30 border border-white/10 rounded px-2 py-1 text-xs outline-none">
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          {loading && <span className="text-white/40 text-xs">讀取中…</span>}
          {model && !loading && (
            <span className="text-white/40 text-xs">{model.tables.length} 表 · {model.relations.length} 關聯（可拖曳表卡）</span>
          )}
          {/* 縮放控制（致敬 Navicat / DBeaver 的 ER 工具） */}
          <div className="ml-auto flex items-center gap-1">
            <button type="button" className={zbtn} title="縮小" onClick={() => bump(-0.1)}>－</button>
            <span className="text-white/50 text-xs w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button type="button" className={zbtn} title="放大" onClick={() => bump(0.1)}>＋</button>
            <button type="button" className={zbtn} title="符合視窗" onClick={fit}>適配</button>
            <button type="button" className={zbtn} title="重置佈局與縮放" onClick={resetLayout}>重置</button>
          </div>
          <button type="button" onClick={onClose} className="text-white/40 hover:text-white">✕</button>
        </div>
        <div ref={viewRef} className="flex-1 overflow-auto relative">
          {err && <div className="p-3 text-red-400 text-sm mono">{err}</div>}
          {model && model.tables.length === 0 && !err && (
            <div className="p-3 text-white/40 text-sm">此資料庫沒有表。</div>
          )}
          {model && model.tables.length > 0 && (
            <div style={{ width: CANVAS_W * zoom, height: CANVAS_H * zoom }}>
              <div className="relative" style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${zoom})`, transformOrigin: "0 0" }}>
                <svg className="absolute inset-0 pointer-events-none" width={CANVAS_W} height={CANVAS_H}>
                  {model.relations.map((r, i) => {
                    const a = center(r.from_table);
                    const b = center(r.to_table);
                    if (!a || !b) return null;
                    const hot = relatedToHover(r.from_table, r.to_table);
                    const dim = hovered != null && !hot;
                    return (
                      <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        stroke={hot ? "#60a5fa" : "#3b82f6"} strokeWidth={hot ? 2.5 : 1.5}
                        opacity={dim ? 0.12 : hot ? 0.95 : 0.55} />
                    );
                  })}
                </svg>
                {model.tables.map((t) => {
                  const p = pos[t.name];
                  if (!p) return null;
                  const hot = hovered === t.name;
                  return (
                    <div key={t.name}
                      onMouseEnter={() => setHovered(t.name)}
                      onMouseLeave={() => setHovered((h) => (h === t.name ? null : h))}
                      className={`absolute bg-[#1a212b] rounded shadow-lg text-xs border ${hot ? "border-blue-400/80" : "border-white/15"}`}
                      style={{ left: p.x, top: p.y, width: CARD_W }}>
                      <div className="px-2 py-1 bg-[#22304a] rounded-t font-medium cursor-move select-none truncate"
                        onPointerDown={(e) => startDrag(t.name, e)} title={t.name}>
                        {t.name}
                      </div>
                      <div>
                        {t.columns.map((c) => (
                          <div key={c.name} className="flex items-center gap-1 px-2 py-0.5 border-t border-white/5">
                            <span className="w-3 shrink-0">{c.pk ? "🔑" : c.fk ? "🔗" : ""}</span>
                            <span className={`truncate flex-1 ${c.fk ? "text-blue-300" : ""}`}>{c.name}</span>
                            <span className="text-white/30 truncate max-w-[72px] mono">{c.data_type}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
