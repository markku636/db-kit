// 側欄的「SSH 主機」區塊：資料夾 + 主機清單（獨立於資料庫連線，不進 DbKind / selectedNode）。
// 單擊只在本區高亮，雙擊 / Enter 開終端機分頁；右鍵有連線 / SFTP / 編輯 / 複製 / 刪除 / 移到資料夾。
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Folder, FolderPlus, Plus, SquareTerminal } from "lucide-react";
import { useT } from "./i18n";
import { Icon, MenuPanel } from "./ui/index";
import { toast, uiConfirm, uiPrompt } from "./ui";
import type { SshFolder, SshSession, SshTargetRef } from "./sshTypes";
import { filterSessions, groupSessions, sessionLabel, uniqueFolderName, useSshSessions } from "./sshSessions";

const SECTION_KEY = "db-kit:sshSectionCollapsed";
const FOLDERS_KEY = "db-kit:sshFoldersCollapsed";

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

export interface SshHostTreeProps {
  /** 側欄搜尋字（已 trim + lowercase）；非空時全展開、只顯示命中的主機。 */
  q: string;
  onOpen: (target: SshTargetRef, title: string, sessionId?: string, opts?: { sftp?: boolean }) => void;
  onEdit: (s: SshSession | null, folderId?: string | null) => void;
}

export default function SshHostTree({ q, onOpen, onEdit }: SshHostTreeProps) {
  const t = useT();
  const folders = useSshSessions((s) => s.folders);
  const sessions = useSshSessions((s) => s.sessions);
  const loaded = useSshSessions((s) => s.loaded);
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(SECTION_KEY) === "1");
  const [closedFolders, setClosedFolders] = useState<Set<string>>(() => loadSet(FOLDERS_KEY));
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; session?: SshSession; folder?: SshFolder } | null>(null);

  useEffect(() => { if (!loaded) void useSshSessions.getState().load(); }, [loaded]);

  const filtered = useMemo(() => (q ? filterSessions(sessions, q) : sessions), [sessions, q]);
  const grouped = useMemo(() => groupSessions(folders, filtered), [folders, filtered]);

  const toggleSection = () => {
    const v = !collapsed;
    setCollapsed(v);
    try { localStorage.setItem(SECTION_KEY, v ? "1" : "0"); } catch { /* 忽略 */ }
  };
  const toggleFolder = (id: string) =>
    setClosedFolders((s) => { const next = new Set(s); if (!next.delete(id)) next.add(id); saveSet(FOLDERS_KEY, next); return next; });

  const open = (s: SshSession, sftp = false) => onOpen({ kind: "session", id: s.id }, sessionLabel(s), s.id, { sftp });

  const addFolder = async () => {
    const name = await uiPrompt(t("資料夾名稱"), { title: t("新資料夾"), defaultValue: uniqueFolderName(folders, t("新資料夾")) });
    if (!name?.trim()) return;
    try { await useSshSessions.getState().addFolder(name.trim()); } catch (e) { toast.error(String((e as Error)?.message ?? e)); }
  };
  const renameFolder = async (f: SshFolder) => {
    const name = await uiPrompt(t("重新命名資料夾"), { title: t("重新命名"), defaultValue: f.name });
    if (!name?.trim() || name.trim() === f.name) return;
    try { await useSshSessions.getState().renameFolder(f.id, name.trim()); } catch (e) { toast.error(String((e as Error)?.message ?? e)); }
  };
  const removeFolder = async (f: SshFolder) => {
    const ok = await uiConfirm(t("刪除資料夾「{name}」？裡面的主機會移到未分類。", { name: f.name }), { title: t("刪除資料夾"), danger: true, confirmText: t("刪除") });
    if (!ok) return;
    try { await useSshSessions.getState().removeFolder(f.id); } catch (e) { toast.error(String((e as Error)?.message ?? e)); }
  };
  const removeSession = async (s: SshSession) => {
    const ok = await uiConfirm(t("刪除 SSH 主機「{name}」？儲存的密碼也會一併移除。", { name: sessionLabel(s) }), { title: t("刪除 SSH 主機"), danger: true, confirmText: t("刪除") });
    if (!ok) return;
    try { await useSshSessions.getState().remove(s.id); } catch (e) { toast.error(String((e as Error)?.message ?? e)); }
  };
  const duplicate = (s: SshSession) => onEdit({ ...s, id: crypto.randomUUID(), name: s.name ? `${s.name} (2)` : "" }, s.folder_id);

  const onRowKey = (e: ReactKeyboardEvent, s: SshSession) => {
    if (e.key === "Enter") { e.preventDefault(); open(s); }
  };

  const renderSession = (s: SshSession, depth: number) => (
    <div
      key={s.id}
      tabIndex={0}
      role="treeitem"
      onClick={() => setSelected(s.id)}
      onDoubleClick={() => open(s)}
      onKeyDown={(e) => onRowKey(e, s)}
      onContextMenu={(e) => { e.preventDefault(); setSelected(s.id); setMenu({ x: e.clientX, y: e.clientY, session: s }); }}
      title={`${s.username}@${s.host}:${s.port}`}
      style={{ paddingLeft: 12 + depth * 14 }}
      className={`flex items-center gap-1.5 pr-2 py-1 cursor-pointer select-none outline-none ${selected === s.id ? "bg-accent/15" : "hover:bg-fg/5"}`}
    >
      <Icon icon={SquareTerminal} size={13} className="text-emerald-300/80 shrink-0" />
      <span className="truncate flex-1">{sessionLabel(s)}</span>
      {s.name && <span className="text-[10px] text-fg/30 truncate max-w-[110px] mono">{s.username}@{s.host}</span>}
    </div>
  );

  const total = sessions.length;
  const showBody = !collapsed || !!q;

  return (
    <div className="border-t border-fg/10 py-1" data-ssh-host-tree="">
      <div
        className="group px-2 py-1 text-[10px] uppercase tracking-wide text-fg/35 flex items-center gap-1 cursor-pointer select-none"
        onClick={toggleSection}
      >
        <Icon icon={showBody ? ChevronDown : ChevronRight} size={11} className="text-fg/40" />
        <span>{t("SSH 主機")}{total ? ` (${total})` : ""}</span>
        <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button type="button" onClick={(e) => { e.stopPropagation(); void addFolder(); }} title={t("新資料夾")} aria-label={t("新資料夾")}
            className="w-5 h-5 grid place-items-center rounded text-fg/40 hover:text-fg/80 hover:bg-fg/10">
            <Icon icon={FolderPlus} size={12} />
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(null, null); }} title={t("新增 SSH 主機")} aria-label={t("新增 SSH 主機")}
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
          {loaded && total === 0 && !q && (
            <button type="button" onClick={() => onEdit(null, null)}
              className="mx-3 my-1 text-[11px] text-fg/40 hover:text-fg/70 inline-flex items-center gap-1">
              <Icon icon={Plus} size={11} />{t("新增 SSH 主機…")}
            </button>
          )}
        </div>
      )}

      {menu && (
        <MenuPanel x={menu.x} y={menu.y} minW={170} onClose={() => setMenu(null)}>
          {(menu.session
            ? ([
                [t("連線"), () => open(menu.session!), false],
                [t("開啟 SFTP"), () => open(menu.session!, true), false],
                [t("編輯…"), () => onEdit(menu.session!, menu.session!.folder_id), false],
                [t("複製"), () => duplicate(menu.session!), false],
                ...(folders.length
                  ? [
                      ...folders.filter((f) => f.id !== menu.session!.folder_id).map((f) =>
                        [t("移到「{name}」", { name: f.name }), () => void useSshSessions.getState().moveToFolder(menu.session!.id, f.id), false] as [string, () => void, boolean]),
                      ...(menu.session!.folder_id ? [[t("移出資料夾"), () => void useSshSessions.getState().moveToFolder(menu.session!.id, null), false] as [string, () => void, boolean]] : []),
                    ]
                  : []),
                [t("刪除"), () => void removeSession(menu.session!), true],
              ] as [string, () => void, boolean][])
            : ([
                [t("新增 SSH 主機…"), () => onEdit(null, menu.folder!.id), false],
                [t("重新命名…"), () => void renameFolder(menu.folder!), false],
                [t("刪除資料夾"), () => void removeFolder(menu.folder!), true],
              ] as [string, () => void, boolean][])
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
