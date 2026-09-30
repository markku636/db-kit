// 文字比對：左右並排、逐塊差異、兩邊都可編輯，每一塊可單獨套到另一邊，改完存回原檔（本機或遠端）。
//
// 用 @codemirror/merge 的 MergeView（兩個真正的編輯器）而不是自己畫 diff：行內差異、未變動區段摺疊、
// 兩邊捲動對齊都是現成的，編輯後差異也即時重算。它內建的「還原這一塊」只能設一個方向，所以按鈕自己畫
// （→ / ← 兩顆），複製邏輯照它的 revertClicked 寫——兩個方向都能逐塊套用。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDefaultExtensions } from "@uiw/react-codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { sql, StandardSQL } from "@codemirror/lang-sql";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import {
  AlertTriangle, ArrowDown, ArrowLeftToLine, ArrowRightToLine, ArrowUp, ChevronsLeft, ChevronsRight,
  FoldVertical, RefreshCw, Save, TextWrap,
} from "lucide-react";
import { useT } from "./i18n";
import { useTheme } from "./theme";
import { resolveEditorTheme } from "./editorThemes";
import { Button, Icon, IconButton, Spinner } from "./ui/index";
import { toast, uiConfirm } from "./ui";
import { loadText, saveText, type LoadedText, type ReadySide } from "./compareIo";
import { errCode, errMsg } from "./useRemoteSession";

type Side = "a" | "b";

/** 依副檔名挑語法高亮（只有已安裝的語言；其他純文字）。 */
function languageFor(path: string): Extension[] {
  const ext = path.toLowerCase().split(/[\\/]/).pop()?.split(".").pop() ?? "";
  if (ext === "sql") return [sql({ dialect: StandardSQL })];
  if (ext === "json" || ext === "jsonc") return [json()];
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return [javascript({ jsx: ext === "jsx" })];
  if (["ts", "mts", "cts", "tsx"].includes(ext)) return [javascript({ typescript: true, jsx: ext === "tsx" })];
  return [];
}

function sidePath(s: ReadySide): string {
  return s.kind === "paste" ? "" : s.path;
}

/** 把 mv 的第 i 塊從一邊複製到另一邊（與 MergeView 內建的 revertClicked 同一套位移規則）。 */
export function copyChunk(mv: MergeView, i: number, toB: boolean): boolean {
  const c = mv.chunks[i];
  if (!c) return false;
  const [src, dst, sf, st, df, dt] = toB
    ? [mv.a, mv.b, c.fromA, c.toA, c.fromB, c.toB]
    : [mv.b, mv.a, c.fromB, c.toB, c.fromA, c.toA];
  if (!dst.state.facet(EditorView.editable)) return false;
  let insert = src.state.sliceDoc(sf, Math.max(sf, st - 1));
  if (sf !== st && dt <= dst.state.doc.length) insert += src.state.lineBreak;
  dst.dispatch({ changes: { from: df, to: Math.min(dst.state.doc.length, dt), insert }, userEvent: "revert" });
  return true;
}

/** 游標所在（或其後第一個）差異塊的索引；沒有差異回 -1。 */
function currentChunk(mv: MergeView, side: Side): number {
  const view = side === "a" ? mv.a : mv.b;
  const pos = view.state.selection.main.head;
  const chunks = mv.chunks;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const [from, to] = side === "a" ? [c.fromA, c.toA] : [c.fromB, c.toB];
    if (pos <= Math.max(from, to)) return i;
  }
  return chunks.length - 1;
}

interface Props {
  scope: string;
  left: ReadySide;
  right: ReadySide;
  /** 這個分頁目前在前景（背景分頁不攔 Ctrl+S）。 */
  active: boolean;
  onBinary: () => void;
}

export default function TextComparePane({ scope, left, right, active, onBinary }: Props) {
  const t = useT();
  const themeId = useTheme((s) => s.themeId);
  const appTheme = useTheme((s) => s.theme);
  const [loaded, setLoaded] = useState<{ a: LoadedText; b: LoadedText } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 每次「兩邊重新讀進來」遞增：MergeView 只在這時（與主題 / 換行改變時）重建，存檔更新基準不重建。
  const [gen, setGen] = useState(0);
  const [dirty, setDirty] = useState<{ a: boolean; b: boolean }>({ a: false, b: false });
  const [stats, setStats] = useState({ chunks: 0, add: 0, del: 0 });
  const [collapse, setCollapse] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [saving, setSaving] = useState<Side | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const mvRef = useRef<MergeView | null>(null);
  const lastSide = useRef<Side>("a");
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  // ---- 載入兩邊 ----
  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setLoadErr(null);
    setDirty({ a: false, b: false });
    mvRef.current?.destroy();
    mvRef.current = null;
    Promise.all([loadText(scope, left), loadText(scope, right)])
      .then(([a, b]) => { if (alive) { setLoaded({ a, b }); setGen((g) => g + 1); } })
      .catch((e) => { if (alive) setLoadErr(errMsg(e)); });
    return () => { alive = false; };
    // left / right 物件每次 render 都是新的；以內容判斷要不要重載。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, JSON.stringify(left), JSON.stringify(right), reloadKey]);

  const refreshStats = useCallback(() => {
    const mv = mvRef.current;
    if (!mv) return;
    let add = 0;
    let del = 0;
    for (const c of mv.chunks) {
      if (c.toA > c.fromA) del += mv.a.state.doc.lineAt(Math.max(c.fromA, c.toA - 1)).number - mv.a.state.doc.lineAt(c.fromA).number + 1;
      if (c.toB > c.fromB) add += mv.b.state.doc.lineAt(Math.max(c.fromB, c.toB - 1)).number - mv.b.state.doc.lineAt(c.fromB).number + 1;
    }
    setStats({ chunks: mv.chunks.length, add, del });
  }, []);

  const theme = resolveEditorTheme(themeId, appTheme);
  const truncated = !!loaded && (loaded.a.truncated || loaded.b.truncated);

  // ---- 建立 MergeView（載入完成 / 主題 / 換行設定變了才重建；重建時保留目前的編輯內容）----
  useEffect(() => {
    const host = hostRef.current;
    const loaded = loadedRef.current;
    if (!host || !loaded) return;
    const prev = mvRef.current;
    const docA = prev ? prev.a.state.doc.toString() : loaded.a.text;
    const docB = prev ? prev.b.state.doc.toString() : loaded.b.text;
    prev?.destroy();
    const base = (side: Side, path: string, readOnly: boolean): Extension[] => [
      ...getDefaultExtensions({
        theme,
        basicSetup: { lineNumbers: true, foldGutter: false, autocompletion: false, highlightActiveLine: true, searchKeymap: true },
      }),
      ...languageFor(path),
      ...(wrap ? [EditorView.lineWrapping] : []),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      keymap.of([
        { key: "Alt-ArrowDown", run: goToNextChunk },
        { key: "Alt-ArrowUp", run: goToPreviousChunk },
      ]),
      EditorView.updateListener.of((u) => {
        if (u.focusChanged && u.view.hasFocus) lastSide.current = side;
        if (u.docChanged) {
          const cur = loadedRef.current;
          if (cur) setDirty((d) => ({ ...d, [side]: u.state.doc.toString() !== cur[side].text }));
          requestAnimationFrame(refreshStats);
        }
      }),
    ];
    const renderControl = () => {
      const wrapEl = document.createElement("div");
      wrapEl.className = "dbk-merge-ctl";
      const mk = (label: string, title: string, toB: boolean) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.setAttribute("aria-label", title);
        // mousedown 在按鈕上就吃掉：否則會冒泡到 MergeView 自己的 revert 監聽，照它設定的單一方向再做一次。
        b.onmousedown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const mv = mvRef.current;
          const i = Number(wrapEl.dataset.chunk);
          if (mv && !Number.isNaN(i)) copyChunk(mv, i, toB);
        };
        return b;
      };
      wrapEl.append(mk("→", t("這一塊套到右邊"), true), mk("←", t("這一塊套到左邊"), false));
      return wrapEl;
    };
    const mv = new MergeView({
      a: { doc: docA, extensions: base("a", sidePath(left), left.kind !== "paste" && loaded.a.truncated) },
      b: { doc: docB, extensions: base("b", sidePath(right), right.kind !== "paste" && loaded.b.truncated) },
      parent: host,
      highlightChanges: true,
      gutter: true,
      revertControls: "a-to-b",
      renderRevertControl: renderControl,
      collapseUnchanged: collapse ? { margin: 3, minSize: 4 } : undefined,
      // 大檔：預設 scanLimit 500 對長檔會退化成整段標成不同；放寬並設時限，避免卡住 UI。
      diffConfig: { scanLimit: 5000, timeout: 2000 },
    });
    mvRef.current = mv;
    requestAnimationFrame(refreshStats);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen, theme, wrap, t]);

  useEffect(() => () => { mvRef.current?.destroy(); mvRef.current = null; }, []);

  useEffect(() => {
    mvRef.current?.reconfigure({ collapseUnchanged: collapse ? { margin: 3, minSize: 4 } : undefined });
  }, [collapse]);

  const move = (dir: 1 | -1) => {
    const mv = mvRef.current;
    if (!mv) return;
    const view = lastSide.current === "a" ? mv.a : mv.b;
    (dir === 1 ? goToNextChunk : goToPreviousChunk)({ state: view.state, dispatch: view.dispatch });
    view.focus();
  };

  const copyCurrent = (toB: boolean) => {
    const mv = mvRef.current;
    if (!mv) return;
    const i = currentChunk(mv, lastSide.current);
    if (i < 0 || !copyChunk(mv, i, toB)) toast.info(t("沒有可套用的差異"));
  };

  const copyAll = async (toB: boolean) => {
    const mv = mvRef.current;
    if (!mv) return;
    const [src, dst] = toB ? [mv.a, mv.b] : [mv.b, mv.a];
    if (!dst.state.facet(EditorView.editable)) return;
    const ok = await uiConfirm(toB ? t("用左邊的內容取代整個右邊？") : t("用右邊的內容取代整個左邊？"), { title: t("全部套用") });
    if (!ok) return;
    dst.dispatch({ changes: { from: 0, to: dst.state.doc.length, insert: src.state.doc.toString() }, userEvent: "revert" });
  };

  const save = useCallback(async (side: Side, force = false) => {
    const mv = mvRef.current;
    const cur = loadedRef.current;
    const s = side === "a" ? left : right;
    if (!mv || !cur || s.kind === "paste" || cur[side].truncated) return;
    const content = (side === "a" ? mv.a : mv.b).state.doc.toString();
    setSaving(side);
    try {
      const next = await saveText(s, cur[side], content, force);
      setLoaded((l) => (l ? { ...l, [side]: next } : l));
      setDirty((d) => ({ ...d, [side]: false }));
      toast.success(t("已儲存"));
    } catch (e) {
      if (errCode(e) === "ERR_COMPARE_CONFLICT") {
        const ok = await uiConfirm(t("{msg}\n仍要用目前的內容覆蓋嗎？", { msg: errMsg(e) }), { title: t("檔案已被修改"), danger: true, confirmText: t("覆蓋") });
        if (ok) { setSaving(null); await save(side, true); return; }
      } else toast.error(t("儲存失敗：{msg}", { msg: errMsg(e) }));
    } finally {
      setSaving(null);
    }
  }, [left, right, t]);

  // Ctrl+S：存游標所在的那一邊。只有前景分頁攔，免得兩個比對分頁同時存。
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "s" || e.key === "S")) {
        if (!hostRef.current?.contains(document.activeElement)) return;
        e.preventDefault();
        void save(lastSide.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, save]);

  const reload = async () => {
    if ((dirty.a || dirty.b) && !(await uiConfirm(t("重新載入會丟掉尚未儲存的修改，確定嗎？"), { title: t("重新載入") }))) return;
    setReloadKey((k) => k + 1);
  };

  const binaryHint = loaded && (loaded.a.binary || loaded.b.binary || loaded.a.lossy || loaded.b.lossy);
  const canSave = (side: Side) => {
    const s = side === "a" ? left : right;
    return !!loaded && s.kind !== "paste" && !loaded[side].truncated;
  };

  const saveBtn = (side: Side) => (
    <Button size="sm" variant={dirty[side] ? "primary" : "ghost"} icon={Save} loading={saving === side}
      disabled={!canSave(side) || !dirty[side]} onClick={() => void save(side)}
      data-testid={`cmp-save-${side}`}
      title={side === "a" ? t("儲存左邊（Ctrl+S）") : t("儲存右邊（Ctrl+S）")}>
      {side === "a" ? t("存左邊") : t("存右邊")}
    </Button>
  );

  const summary = useMemo(() => {
    if (!loaded) return "";
    if (stats.chunks === 0) return t("內容相同");
    return t("{n} 處不同", { n: stats.chunks });
  }, [loaded, stats.chunks, t]);

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="text-compare">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-fg/10 bg-panel text-xs">
        {saveBtn("a")}
        <div className="w-px h-4 bg-fg/10 mx-1" />
        <IconButton icon={ArrowUp} label={t("上一個差異（Alt+↑）")} onClick={() => move(-1)} disabled={!stats.chunks} />
        <IconButton icon={ArrowDown} label={t("下一個差異（Alt+↓）")} onClick={() => move(1)} disabled={!stats.chunks} />
        <div className="w-px h-4 bg-fg/10 mx-1" />
        <IconButton icon={ArrowRightToLine} label={t("目前這一塊套到右邊")} onClick={() => copyCurrent(true)} disabled={!stats.chunks} data-testid="cmp-copy-right" />
        <IconButton icon={ArrowLeftToLine} label={t("目前這一塊套到左邊")} onClick={() => copyCurrent(false)} disabled={!stats.chunks} />
        <IconButton icon={ChevronsRight} label={t("全部套到右邊")} onClick={() => void copyAll(true)} disabled={!stats.chunks} />
        <IconButton icon={ChevronsLeft} label={t("全部套到左邊")} onClick={() => void copyAll(false)} disabled={!stats.chunks} />
        <div className="w-px h-4 bg-fg/10 mx-1" />
        <IconButton icon={FoldVertical} label={t("摺疊相同的段落")} active={collapse} onClick={() => setCollapse((v) => !v)} />
        <IconButton icon={TextWrap} label={t("自動換行")} active={wrap} onClick={() => setWrap((v) => !v)} />
        <IconButton icon={RefreshCw} label={t("重新載入兩邊")} onClick={() => void reload()} />
        <span className="ml-2 text-fg/50 whitespace-nowrap" data-testid="cmp-summary">
          {summary}
          {stats.chunks > 0 && (
            <span className="mono ml-2"><span className="text-emerald-400">+{stats.add}</span> <span className="text-danger">−{stats.del}</span></span>
          )}
        </span>
        <div className="ml-auto">{saveBtn("b")}</div>
      </div>

      {(truncated || binaryHint) && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] text-amber-200/90 bg-amber-500/10 border-b border-amber-500/20">
          <Icon icon={AlertTriangle} size={13} className="shrink-0" />
          <span className="flex-1">
            {truncated
              ? t("檔案太大，只比對了前 20 MB，且不能存檔。")
              : t("看起來不是 UTF-8 文字檔（含二進位內容或無效字元），文字比對可能不準確。")}
          </span>
          <Button size="sm" variant="ghost" onClick={onBinary}>{t("改用二進位比較")}</Button>
        </div>
      )}

      {loadErr ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-xs text-fg/60 p-6">
          <div className="text-danger text-center max-w-xl break-all">{loadErr}</div>
          <Button size="sm" icon={RefreshCw} onClick={() => setReloadKey((k) => k + 1)}>{t("重試")}</Button>
        </div>
      ) : !loaded ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-xs text-fg/50"><Spinner size={14} />{t("讀取中…")}</div>
      ) : null}
      <div ref={hostRef} className={`dbk-merge flex-1 min-h-0 overflow-auto ${loaded && !loadErr ? "" : "hidden"}`} />
    </div>
  );
}
