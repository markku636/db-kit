import { useEffect, useRef, useState } from "react";
import { KeyRound, Link2, Minus, Plus, X } from "lucide-react";
import { api, ErModel, ErTable } from "./api";
import Icon from "./ui/Icon";
import { IconButton } from "./ui/index";
import { useModalOverlay } from "./ui";
import { useT } from "./i18n";

const CARD_W = 210;
const CANVAS_W = 2400;
const CANVAS_H = 1600;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2;

export default function ErDiagram({ connId, onClose, initialDb, focusTable }: {
  connId: string;
  onClose: () => void;
  initialDb?: string;   // 開啟時預選的資料庫 / schema（由「逆向至模型」帶入該表所屬庫）
  focusTable?: string;  // 開啟時高亮的資料表（突顯該表與其關聯）
}) {
  const t = useT();
  useModalOverlay(onClose); // Esc 關閉 + 計入 modalCount
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState("");
  const [model, setModel] = useState<ErModel | null>(null);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<string | null>(null);
  // 「逆向至模型」聚焦的表：與 hovered 分開，避免一移動滑鼠就被清掉（hovered 由卡片 mouseenter/leave 驅動）。
  const [focused, setFocused] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  // 進行中拖曳的監聽卸載函式；卸載時用來移除 window 監聽，避免洩漏。
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  const layoutKey = `er-pos:${connId}:${db}`;

  useEffect(() => {
    api
      .listDatabases(connId)
      .then((d) => { setDbs(d); setDb((cur) => cur || initialDb || d[0] || ""); })
      .catch((e) => setErr(e?.message ?? t("讀取資料庫失敗")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  // 「逆向至模型」聚焦：模型載入後若含目標表則持久高亮它（及其關聯線），不受滑鼠移動影響。
  useEffect(() => {
    if (focusTable && model?.tables.some((tbl) => tbl.name === focusTable)) setFocused(focusTable);
  }, [model, focusTable]);

  // 預設網格佈局；若 localStorage 有此 DB 的存檔位置則覆蓋（拖曳後的佈局可保留）。
  const gridLayout = (m: ErModel): Record<string, { x: number; y: number }> => {
    const p: Record<string, { x: number; y: number }> = {};
    m.tables.forEach((tbl, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      p[tbl.name] = { x: 24 + col * (CARD_W + 60), y: 24 + row * 250 };
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
          for (const val of m.tables) {
            if (saved[val.name] && typeof saved[val.name].x === "number") base[val.name] = saved[val.name];
          }
        } catch {
          /* 忽略損毀的存檔 */
        }
        setPos(base);
      })
      .catch((e) => { if (!cancelled) { setErr(e?.message ?? t("讀取 ER 失敗")); setModel(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db]);

  const tableByName = (n: string) => model?.tables.find((tbl) => tbl.name === n);
  const cardH = (item: ErTable) => 26 + item.columns.length * 20 + 4;
  const center = (name: string) => {
    const tbl = tableByName(name);
    const p = pos[name];
    if (!tbl || !p) return null;
    return { x: p.x + CARD_W / 2, y: p.y + cardH(tbl) / 2 };
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
    for (const val of model.tables) {
      const p = pos[val.name];
      if (!p) continue;
      maxX = Math.max(maxX, p.x + CARD_W);
      maxY = Math.max(maxY, p.y + cardH(val));
    }
    const vw = viewRef.current.clientWidth - 48;
    const vh = viewRef.current.clientHeight - 48;
    const z = Math.min(1, vw / maxX, vh / maxY);
    setZoom(Math.max(ZOOM_MIN, +z.toFixed(2)));
  };

  const bump = (delta: number) =>
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + delta).toFixed(2))));

  // 高亮對象：以 hover 優先，否則用「逆向至模型」聚焦的表（持久）。
  const active = hovered ?? focused;
  // 該關聯是否與目前高亮的表卡相連（用於高亮）。
  const relatedToHover = (fromT: string, toT: string) =>
    active != null && (active === fromT || active === toT);

  const zbtn = "px-2 py-0.5 rounded border border-fg/15 hover:bg-fg/10 text-fg/70 text-xs";

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-panel w-[92vw] h-[88vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-2 border-b border-fg/10 flex items-center gap-3 text-sm">
          <span className="font-medium">{t("ER 圖")}</span>
          <select value={db} onChange={(e) => setDb(e.target.value)} title={t("選擇資料庫 / schema")}
            className="bg-inset border border-fg/10 rounded px-2 py-1 text-xs outline-none">
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          {loading && <span className="text-fg/40 text-xs">{t("讀取中…")}</span>}
          {model && !loading && (
            <span className="text-fg/40 text-xs">{t("{tables} 表 · {relations} 關聯（可拖曳表卡）", { tables: model.tables.length, relations: model.relations.length })}</span>
          )}
          {/* 縮放控制（致敬 Navicat / DBeaver 的 ER 工具） */}
          <div className="ml-auto flex items-center gap-1">
            <button type="button" className={zbtn} title={t("縮小")} aria-label={t("縮小")} onClick={() => bump(-0.1)}><Icon icon={Minus} size={14} /></button>
            <span className="text-fg/50 text-xs w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <button type="button" className={zbtn} title={t("放大")} aria-label={t("放大")} onClick={() => bump(0.1)}><Icon icon={Plus} size={14} /></button>
            <button type="button" className={zbtn} title={t("符合視窗")} onClick={fit}>{t("適配")}</button>
            <button type="button" className={zbtn} title={t("重置佈局與縮放")} onClick={resetLayout}>{t("重置")}</button>
          </div>
          <IconButton icon={X} label={t("關閉")} onClick={onClose} className="text-fg/40 hover:text-fg" />
        </div>
        <div ref={viewRef} className="flex-1 overflow-auto relative">
          {err && <div className="p-3 text-red-400 text-sm mono">{err}</div>}
          {model && model.tables.length === 0 && !err && (
            <div className="p-3 text-fg/40 text-sm">{t("此資料庫沒有表。")}</div>
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
                    const dim = active != null && !hot;
                    return (
                      <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                        stroke={hot ? "#60a5fa" : "#3b82f6"} strokeWidth={hot ? 2.5 : 1.5}
                        opacity={dim ? 0.12 : hot ? 0.95 : 0.55} />
                    );
                  })}
                </svg>
                {model.tables.map((tbl) => {
                  const p = pos[tbl.name];
                  if (!p) return null;
                  const hot = active === tbl.name;
                  return (
                    <div key={tbl.name}
                      onMouseEnter={() => setHovered(tbl.name)}
                      onMouseLeave={() => setHovered((h) => (h === tbl.name ? null : h))}
                      className={`absolute bg-elevated rounded shadow-lg text-xs border ${hot ? "border-accent/80" : "border-fg/15"}`}
                      style={{ left: p.x, top: p.y, width: CARD_W }}>
                      <div className="px-2 py-1 bg-blue-500/25 rounded-t font-medium cursor-move select-none truncate"
                        onPointerDown={(e) => startDrag(tbl.name, e)} title={tbl.name}>
                        {tbl.name}
                      </div>
                      <div>
                        {tbl.columns.map((c) => (
                          <div key={c.name} className="flex items-center gap-1 px-2 py-0.5 border-t border-fg/5">
                            <span className="w-3 shrink-0 flex items-center">{c.pk ? <Icon icon={KeyRound} size={12} className="text-amber-400" /> : c.fk ? <Icon icon={Link2} size={12} className="text-blue-300" /> : null}</span>
                            <span className={`truncate flex-1 ${c.fk ? "text-blue-300" : ""}`}>{c.name}</span>
                            <span className="text-fg/30 truncate max-w-[72px] mono">{c.data_type}</span>
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
