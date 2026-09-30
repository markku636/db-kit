// 比對分頁：兩邊還沒選好 → 啟動畫面；選好 → 遠端那邊先連線，再依模式顯示文字 / 資料夾 / 二進位比對。
// 分頁切走時不卸載（MainArea 常駐所有比對分頁：比對結果與未存的編輯不因切分頁消失），真正關閉才收連線、刪暫存檔。
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Binary, FileDiff, FolderTree, Pencil, RefreshCw, Unplug, X } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { useStore } from "./store";
import { Button, Icon, Segmented, Spinner } from "./ui/index";
import {
  childEndpoint, compareTitle, endpointLong, swapSides, type CompareMode, type CompareTab, type Endpoint,
} from "./compareTabs";
import { readySide, type ReadySide } from "./compareIo";
import { useRemoteSession, type RemoteSession } from "./useRemoteSession";
import CompareLauncher from "./CompareLauncher";

const TextComparePane = lazy(() => import("./TextComparePane"));
const FolderComparePane = lazy(() => import("./FolderComparePane"));
const BinaryComparePane = lazy(() => import("./BinaryComparePane"));

export const MODE_ICON: Record<CompareMode, typeof FileDiff> = { text: FileDiff, folder: FolderTree, binary: Binary };

function remoteTarget(ep: Endpoint | null) {
  return ep?.side === "remote" ? ep.target : null;
}

function SideStatus({ label, s }: { label: string; s: RemoteSession }) {
  const t = useT();
  if (s.status === "idle" || s.status === "connected") return null;
  return (
    <div className="flex items-center gap-3 px-4 py-2 rounded bg-elevated border border-fg/10 text-xs shadow-lg max-w-xl">
      {s.status === "connecting" ? <Spinner size={14} /> : <Icon icon={Unplug} size={14} className="text-danger shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="truncate">
          {s.status === "connecting" ? t("連線中：{target}", { target: label }) : s.status === "cancelled" ? t("已取消連線：{target}", { target: label }) : t("連線失敗：{target}", { target: label })}
        </div>
        {s.error && <div className="text-fg/50 mono text-[11px] break-all">{s.error}</div>}
      </div>
      {s.status === "connecting"
        ? <Button size="sm" onClick={s.cancel}>{t("取消")}</Button>
        : <Button size="sm" variant="primary" icon={RefreshCw} onClick={s.reconnect}>{t("重新連線")}</Button>}
    </div>
  );
}

export default function ComparePane({ tab, active }: { tab: CompareTab; active: boolean }) {
  const t = useT();
  const updateCompareTab = useStore((s) => s.updateCompareTab);
  const openCompareTab = useStore((s) => s.openCompareTab);
  const closeCompareTab = useStore((s) => s.closeCompareTab);
  const [editing, setEditing] = useState(false);
  const configured = !!tab.left && !!tab.right && !editing;
  // 啟動畫面還在選的時候不連線：選主機的過程中每換一台就連一次太浪費，也會一直跳密碼框。
  const left = useRemoteSession(configured ? remoteTarget(tab.left) : null);
  const right = useRemoteSession(configured ? remoteTarget(tab.right) : null);
  const pasteLabel = t("貼上的文字");

  // 分頁關閉（卸載）：刪掉這個分頁下載的遠端暫存檔。連線由 useRemoteSession 自己收。
  useEffect(() => () => { void api.cmpRelease(tab.key).catch(() => undefined); }, [tab.key]);

  const ready = useMemo<{ a: ReadySide; b: ReadySide } | null>(() => {
    if (!configured || !tab.left || !tab.right) return null;
    const a = readySide(tab.left, left);
    const b = readySide(tab.right, right);
    return a && b ? { a, b } : null;
  }, [configured, tab.left, tab.right, left, right]);

  const openPair = (leftRel: string, rightRel: string, mode: CompareMode) => {
    if (!tab.left || !tab.right) return;
    const l = childEndpoint(tab.left, leftRel);
    const r = childEndpoint(tab.right, rightRel);
    openCompareTab({ mode, left: l, right: r, title: compareTitle(l, r, pasteLabel) });
  };

  if (!configured) {
    return (
      <div className={active ? "flex-1 flex flex-col min-w-0 min-h-0" : "hidden"} data-testid="compare-pane">
        <CompareLauncher
          tab={tab}
          onStart={(patch) => {
            setEditing(false);
            updateCompareTab(tab.key, { ...patch, title: compareTitle(patch.left, patch.right, pasteLabel) });
          }}
          onCancel={tab.left && tab.right ? () => setEditing(false) : () => closeCompareTab(tab.key)}
        />
      </div>
    );
  }

  const fileMode = tab.mode !== "folder";
  const ModeIcon = MODE_ICON[tab.mode];
  return (
    <div className={active ? "flex-1 flex flex-col min-w-0 min-h-0" : "hidden"} data-testid="compare-pane">
      <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-fg/10 bg-panel text-xs">
        <Icon icon={ModeIcon} size={14} className="shrink-0 text-accent" />
        <span className="truncate mono text-fg/80 min-w-0 flex-1 text-right" title={endpointLong(tab.left, pasteLabel)}>{endpointLong(tab.left, pasteLabel)}</span>
        <button type="button" data-testid="cmp-swap" title={t("交換左右兩邊")} aria-label={t("交換左右兩邊")}
          onClick={() => updateCompareTab(tab.key, { ...swapSides(tab), title: compareTitle(tab.right, tab.left, pasteLabel) })}
          className="w-6 h-6 shrink-0 flex items-center justify-center rounded text-fg/50 hover:text-fg hover:bg-fg/10">
          <Icon icon={ArrowLeftRight} size={13} />
        </button>
        <span className="truncate mono text-fg/80 min-w-0 flex-1" title={endpointLong(tab.right, pasteLabel)}>{endpointLong(tab.right, pasteLabel)}</span>
        {fileMode && tab.left?.side !== "paste" && tab.right?.side !== "paste" && (
          <Segmented<CompareMode> size="sm" ariaLabel={t("比對方式")} value={tab.mode}
            onChange={(mode) => updateCompareTab(tab.key, { mode })}
            options={[{ value: "text", label: t("文字") }, { value: "binary", label: t("二進位") }]} />
        )}
        <Button size="sm" variant="ghost" icon={Pencil} className="shrink-0 whitespace-nowrap" onClick={() => setEditing(true)}>{t("變更來源")}</Button>
        <button type="button" title={t("關閉分頁")} aria-label={t("關閉分頁")} onClick={() => closeCompareTab(tab.key)}
          className="w-6 h-6 shrink-0 flex items-center justify-center rounded text-fg/40 hover:text-fg hover:bg-fg/10">
          <Icon icon={X} size={13} />
        </button>
      </div>

      {!ready ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6">
          <SideStatus label={endpointLong(tab.left, pasteLabel)} s={left} />
          <SideStatus label={endpointLong(tab.right, pasteLabel)} s={right} />
        </div>
      ) : (
        <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Spinner size={16} /></div>}>
          {tab.mode === "text" && (
            <TextComparePane scope={tab.key} left={ready.a} right={ready.b} active={active}
              onBinary={() => updateCompareTab(tab.key, { mode: "binary" })} />
          )}
          {tab.mode === "binary" && <BinaryComparePane scope={tab.key} left={ready.a} right={ready.b} />}
          {tab.mode === "folder" && (
            <FolderComparePane scope={tab.key} left={ready.a} right={ready.b} active={active} onOpenPair={openPair} />
          )}
        </Suspense>
      )}
      {left.prompts}
      {right.prompts}
    </div>
  );
}
