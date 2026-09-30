// 側欄的「遠端桌面」區塊：資料夾 + RDP / VNC / RustDesk 主機（與 SSH 主機分開存、分開顯示）。
// 單擊高亮、雙擊 / Enter 開遠端桌面分頁；右鍵有連線 / 全螢幕連線 / 編輯 / 複製 / 刪除 / 移到資料夾。
// 一台都沒有時整個區塊不顯示（同 SSH）：新增走「新增連線 → 遠端主機」、貼 rdp:// vnc:// rustdesk:// 字串或匯入 .rdp。
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, Expand, FileInput, Folder, FolderPlus, Pencil, Plus, type LucideIcon } from "lucide-react";
import { useT } from "./i18n";
import { Icon, MenuPanel } from "./ui/index";
import { toast, uiConfirm, uiPrompt } from "./ui";
import { useStore } from "./store";
import type { RdFolder, RdSession } from "./rdTypes";
import { filterRdSessions, groupRdSessions, rdEndpoint, rdProtocolLabel, rdSessionLabel, useRdSessions } from "./rdSessions";
import { uniqueFolderName } from "./sshSessions";
import { RD_META, useRdStatus } from "./rdStatus";

const SECTION_KEY = "db-kit:rdSectionCollapsed";
const FOLDERS_KEY = "db-kit:rdFoldersCollapsed";

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}
function saveSet(key: string, s: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...s])); } catch { /* 忽略 */ }
}

export interface RdHostTreeProps {
  /** 側欄搜尋字（已 trim + lowercase）；非空時全展開、只顯示命中的主機。 */
  q: string;
  onOpen: (s: RdSession, opts?: { fullscreen?: boolean }) => void;
  onEdit: (s: RdSession | null, folderId?: string | null) => void;
  /** 匯入 .rdp 連線檔（開檔案對話框 → 帶入主機對話框）。 */
  onImportRdp: () => void;
}

export default function RdHostTree({ q, onOpen, onEdit, onImportRdp }: RdHostTreeProps) {
  const t = useT();
  const folders = useRdSessions((s) => s.folders);
  const sessions = useRdSessions((s) => s.sessions);
  const loaded = useRdSessions((s) => s.loaded);
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(SECTION_KEY) === "1");
  const [closedFolders, setClosedFolders] = useState<Set<string>>(() => loadSet(FOLDERS_KEY));
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; session?: RdSession; folder?: RdFolder } | null>(null);

  useEffect(() => { if (!loaded) void useRdSessions.getState().load(); }, [loaded]);

  // 已連線的主機 → 它的第一個連著的分頁。選擇器回字串：狀態細節變動時整棵樹不重繪。
  const rdTabs = useStore((s) => s.rdTabs);
  const liveSig = useRdStatus((st) =>
    rdTabs.filter((x) => x.sessionId && st.rt[x.key]?.status === "connected").map((x) => `${x.sessionId}=${x.key}`).join("|"));
  const live = useMemo(() => {
    const m = new Map<string, string>();
    for (const pair of liveSig ? liveSig.split("|") : []) {
      const [sid, key] = pair.split("=");
      if (!m.has(sid)) m.set(sid, key);
    }
    return m;
  }, [liveSig]);

  const filtered = useMemo(() => (q ? filterRdSessions(sessions, q) : sessions), [sessions, q]);
  const grouped = useMemo(() => groupRdSessions(folders, filtered), [folders, filtered]);

  const toggleSection = () => {
    const v = !collapsed;
    setCollapsed(v);
    try { localStorage.setItem(SECTION_KEY, v ? "1" : "0"); } catch { /* 忽略 */ }
  };
  const toggleFolder = (id: string) =>
    setClosedFolders((s) => { const next = new Set(s); if (!next.delete(id)) next.add(id); saveSet(FOLDERS_KEY, next); return next; });

  // 已連線就切到那個分頁，不另開一條；沒連線才開新分頁。
  const focusOrOpen = (s: RdSession, fullscreen = false) => {
    const key = live.get(s.id);
    if (key && !fullscreen) { useStore.getState().setActiveTab(key); return; }
    onOpen(s, { fullscreen });
  };

  const err = (e: unknown) => toast.error(String((e as Error)?.message ?? e));
  const addFolder = async () => {
    const name = await uiPrompt(t("資料夾名稱"), { title: t("新資料夾"), defaultValue: uniqueFolderName(folders, t("新資料夾")) });
    if (!name?.trim()) return;
    try { await useRdSessions.getState().addFolder(name.trim()); } catch (e) { err(e); }
  };
  const renameFolder = async (f: RdFolder) => {
    const name = await uiPrompt(t("重新命名資料夾"), { title: t("重新命名"), defaultValue: f.name });
    if (!name?.trim() || name.trim() === f.name) return;
    try { await useRdSessions.getState().renameFolder(f.id, name.trim()); } catch (e) { err(e); }
  };
  const removeFolder = async (f: RdFolder) => {
    const ok = await uiConfirm(t("刪除資料夾「{name}」？裡面的主機會移到未分類。", { name: f.name }), { title: t("刪除資料夾"), danger: true, confirmText: t("刪除") });
    if (!ok) return;
    try { await useRdSessions.getState().removeFolder(f.id); } catch (e) { err(e); }
  };
  const removeSession = async (s: RdSession) => {
    const ok = await uiConfirm(t("刪除遠端桌面「{name}」？儲存的密碼也會一併移除。", { name: rdSessionLabel(s) }), { title: t("刪除遠端桌面"), danger: true, confirmText: t("刪除") });
    if (!ok) return;
    try { await useRdSessions.getState().remove(s.id); } catch (e) { err(e); }
  };
  const duplicate = (s: RdSession) => onEdit({ ...s, id: crypto.randomUUID(), name: s.name ? `${s.name} (2)` : "" }, s.folder_id);

  const onRowKey = (e: ReactKeyboardEvent, s: RdSession) => {
    if (e.key === "Enter") { e.preventDefault(); focusOrOpen(s); }
  };

  const renderSession = (s: RdSession, depth: number) => {
    const connected = live.has(s.id);
    const meta = RD_META[s.protocol];
    return (
      <div
        key={s.id}
        tabIndex={0}
        role="treeitem"
        data-rd-host={s.id}
        data-connected={connected ? "" : undefined}
        onClick={() => setSelected(s.id)}
        onDoubleClick={() => focusOrOpen(s)}
        onKeyDown={(e) => onRowKey(e, s)}
        onContextMenu={(e) => { e.preventDefault(); setSelected(s.id); setMenu({ x: e.clientX, y: e.clientY, session: s }); }}
        title={`${rdProtocolLabel(s.protocol)} · ${s.username ? `${s.username}@` : ""}${rdEndpoint(s)}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        className={`group flex items-center gap-1.5 pr-2 py-1 cursor-pointer select-none outline-none ${selected === s.id ? "bg-accent/15" : "hover:bg-fg/5"}`}
      >
        <span className="shrink-0 flex" style={{ color: connected ? meta.color : undefined }} title={connected ? t("已連線") : t("未連線")}>
          <Icon icon={meta.icon} size={13} className={connected ? "" : "text-fg/35"} />
        </span>
        <span className="truncate flex-1">{rdSessionLabel(s)}</span>
        <span className="text-[10px] text-fg/30 shrink-0 group-hover:hidden">{rdProtocolLabel(s.protocol)}</span>
        <RowButton icon={meta.icon} label={connected ? t("切到遠端桌面") : t("連線")} onClick={() => focusOrOpen(s)} />
        <RowButton icon={Expand} label={t("全螢幕連線")} onClick={() => focusOrOpen(s, true)} />
        <RowButton icon={Pencil} label={t("編輯遠端桌面")} onClick={() => onEdit(s, s.folder_id)} />
      </div>
    );
  };

  const total = sessions.length;
  const showBody = !collapsed || !!q;
  if (total === 0) return null;

  type Item = [string, () => void, boolean];
  return (
    <div className="border-t border-fg/10 py-1" data-rd-host-tree="">
      <div
        className="group px-2 py-1 text-[10px] uppercase tracking-wide text-fg/35 flex items-center gap-1 cursor-pointer select-none"
        onClick={toggleSection}
      >
        <Icon icon={showBody ? ChevronDown : ChevronRight} size={11} className="text-fg/40" />
        <span>{t("遠端桌面")}{total ? ` (${total})` : ""}</span>
        <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button type="button" onClick={(e) => { e.stopPropagation(); onImportRdp(); }} title={t("匯入 .rdp 連線檔")} aria-label={t("匯入 .rdp 連線檔")}
            className="w-5 h-5 grid place-items-center rounded text-fg/40 hover:text-fg/80 hover:bg-fg/10">
            <Icon icon={FileInput} size={12} />
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); void addFolder(); }} title={t("新資料夾")} aria-label={t("新資料夾")}
            className="w-5 h-5 grid place-items-center rounded text-fg/40 hover:text-fg/80 hover:bg-fg/10">
            <Icon icon={FolderPlus} size={12} />
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(null, null); }} title={t("新增遠端桌面")} aria-label={t("新增遠端桌面")}
            className="w-5 h-5 grid place-items-center rounded text-fg/40 hover:text-fg/80 hover:bg-fg/10">
            <Icon icon={Plus} size={12} />
          </button>
        </span>
      </div>
      {showBody && (
        <div role="tree">
          {grouped.groups.map(({ folder, sessions: list }) => {
            if (q && list.length === 0) return null;
            const closed = !q && closedFolders.has(folder.id);
            return (
              <div key={folder.id}>
                <div
                  onClick={() => toggleFolder(folder.id)}
                  onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, folder }); }}
                  className="flex items-center gap-1.5 px-3 py-1 cursor-pointer select-none hover:bg-fg/5 text-fg/70"
                >
                  <Icon icon={closed ? ChevronRight : ChevronDown} size={11} className="text-fg/40" />
                  <Icon icon={Folder} size={13} className="text-amber-300/70" />
                  <span className="truncate flex-1">{folder.name}</span>
                  <span className="text-[10px] text-fg/30">{list.length}</span>
                </div>
                {!closed && list.map((s) => renderSession(s, 1))}
              </div>
            );
          })}
          {grouped.loose.map((s) => renderSession(s, 0))}
        </div>
      )}

      {menu && (
        <MenuPanel x={menu.x} y={menu.y} minW={170} onClose={() => setMenu(null)}>
          {(menu.session
            ? ([
                [t("連線"), () => focusOrOpen(menu.session!), false],
                [t("全螢幕連線"), () => focusOrOpen(menu.session!, true), false],
                [t("編輯…"), () => onEdit(menu.session!, menu.session!.folder_id), false],
                [t("複製"), () => duplicate(menu.session!), false],
                ...folders.filter((f) => f.id !== menu.session!.folder_id).map((f) =>
                  [t("移到「{name}」", { name: f.name }), () => void useRdSessions.getState().moveToFolder(menu.session!.id, f.id).catch(err), false] as Item),
                ...(menu.session.folder_id ? [[t("移出資料夾"), () => void useRdSessions.getState().moveToFolder(menu.session!.id, null).catch(err), false] as Item] : []),
                [t("刪除"), () => void removeSession(menu.session!), true],
              ] as Item[])
            : ([
                [t("新增遠端桌面…"), () => onEdit(null, menu.folder!.id), false],
                [t("重新命名…"), () => void renameFolder(menu.folder!), false],
                [t("刪除資料夾"), () => void removeFolder(menu.folder!), true],
              ] as Item[])
          ).map(([label, fn, danger]) => (
            <button key={label} type="button"
              onClick={() => { setMenu(null); fn(); }}
              className={`block w-full text-left px-3 py-1.5 hover:bg-fg/10 ${danger ? "text-danger" : "text-fg/80"}`}>
              {label}
            </button>
          ))}
        </MenuPanel>
      )}
    </div>
  );
}

function RowButton({ icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  const stop = (e: ReactMouseEvent) => e.stopPropagation();
  return (
    <button type="button" title={label} aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onDoubleClick={stop}
      className="w-5 h-5 shrink-0 items-center justify-center rounded text-fg/40 hover:bg-fg/15 hover:text-fg/80 hidden group-hover:flex">
      <Icon icon={icon} size={13} />
    </button>
  );
}
