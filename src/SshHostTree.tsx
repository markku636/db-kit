// 側欄的「SSH 主機」區塊：資料夾 + 主機清單（獨立於資料庫連線，不進 DbKind / selectedNode）。
// 單擊只在本區高亮，雙擊 / Enter 開終端機分頁；右鍵有連線 / SFTP / 編輯 / 複製 / 刪除 / 移到資料夾。
// 已連線（有分頁連著）的主機圖示亮起，滑過顯示快速按鈕（終端機 / SFTP / 編輯）。
// 一台主機都沒有時整個區塊不顯示——不是每個人都用 SSH；新增走「新增連線 → SSH / SFTP」或貼 ssh:// 字串。
// FTP 主機也列在這裡（資料夾圖示）：沒有終端機，開啟就是只有檔案面板的分頁。
import { lazy, Suspense, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { AppWindow, ChevronDown, ChevronRight, FileInput, Folder, FolderOpen, FolderPlus, KeyRound, Pencil, Plus, SquareTerminal, type LucideIcon } from "lucide-react";
import { useT } from "./i18n";
import { Icon, MenuPanel } from "./ui/index";
import { toast, uiConfirm, uiPrompt } from "./ui";
import { useStore } from "./store";
import { useSshTerminals } from "./sshTerminals";
import { isFtpHost, type SshFolder, type SshSession, type SshTargetRef } from "./sshTypes";
import { ftpTabOf, type SshTab } from "./sshTabs";
import { filterSessions, groupSessions, sessionLabel, uniqueFolderName, useSshSessions } from "./sshSessions";

// 金鑰管理用得少：第一次打開才下載。
const SshKeyManager = lazy(() => import("./SshKeyManager"));
const SshImportDialog = lazy(() => import("./SshImportDialog"));

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
  onOpen: (target: SshTargetRef, title: string, sessionId?: string, opts?: { sftp?: boolean; sftpWin?: boolean; ftp?: SshTab["ftp"] }) => void;
  onEdit: (s: SshSession | null, folderId?: string | null) => void;
}

export default function SshHostTree({ q, onOpen, onEdit }: SshHostTreeProps) {
  const t = useT();
  const folders = useSshSessions((s) => s.folders);
  const sessions = useSshSessions((s) => s.sessions);
  const loaded = useSshSessions((s) => s.loaded);
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(SECTION_KEY) === "1");
  const [closedFolders, setClosedFolders] = useState<Set<string>>(() => loadSet(FOLDERS_KEY));
  // 選取放在 useSshSessions（右側「詳細資料」面板讀得到）。與資料庫樹的 selectedNode 互斥：
  // 點主機時清掉資料庫節點，資料庫那邊選了東西時清掉主機——面板永遠顯示最後點的那個。
  const selected = useSshSessions((s) => s.selectedId);
  const setSelected = (id: string) => { useSshSessions.getState().select(id); useStore.getState().selectNode(null); };
  const dbNode = useStore((s) => s.selectedNode);
  useEffect(() => { if (dbNode) useSshSessions.getState().select(null); }, [dbNode]);
  const [menu, setMenu] = useState<{ x: number; y: number; session?: SshSession; folder?: SshFolder } | null>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => { if (!loaded) void useSshSessions.getState().load(); }, [loaded]);

  // 已連線的主機 → 它的第一個連著的終端機分頁。選擇器回傳字串：rt 裡的標題 / cwd 更新時字串不變，
  // 整棵樹就不會跟著重繪。
  const sshTabs = useStore((s) => s.sshTabs);
  const liveSig = useSshTerminals((st) =>
    sshTabs.filter((x) => x.sessionId && st.rt[x.key]?.status === "connected").map((x) => `${x.sessionId}=${x.key}`).join("|"));
  const live = useMemo(() => {
    const m = new Map<string, string>();
    for (const pair of liveSig ? liveSig.split("|") : []) {
      const [sid, key] = pair.split("=");
      if (!m.has(sid)) m.set(sid, key);
    }
    return m;
  }, [liveSig]);

  const filtered = useMemo(() => (q ? filterSessions(sessions, q) : sessions), [sessions, q]);
  const grouped = useMemo(() => groupSessions(folders, filtered), [folders, filtered]);

  const toggleSection = () => {
    const v = !collapsed;
    setCollapsed(v);
    try { localStorage.setItem(SECTION_KEY, v ? "1" : "0"); } catch { /* 忽略 */ }
  };
  const toggleFolder = (id: string) =>
    setClosedFolders((s) => { const next = new Set(s); if (!next.delete(id)) next.add(id); saveSet(FOLDERS_KEY, next); return next; });

  // 主機設了「開啟時一併展開 SFTP 面板」（sftp:// 字串建的主機預設開）就一起展開。
  const open = (s: SshSession) =>
    onOpen({ kind: "session", id: s.id }, sessionLabel(s), s.id, { sftp: s.options.ui?.open_sftp === "1", ftp: ftpTabOf(s) });
  // 「開啟 SFTP」（右鍵 / 快速按鈕）開獨立視窗。已連線就沿用那個分頁的連線、不另開一條；
  // 沒連線才開終端機分頁，連上後自動開視窗（這時就不再展開側邊面板）。
  const openSftp = (s: SshSession) => {
    const key = live.get(s.id);
    if (!key) { onOpen({ kind: "session", id: s.id }, sessionLabel(s), s.id, { sftpWin: true, ftp: ftpTabOf(s) }); return; }
    useStore.getState().setActiveTab(key);
    useSshTerminals.getState().patch(key, { sftpWinRequest: true });
  };
  // 快速按鈕：已連線就切到那個分頁，不另開一條連線；沒連線才開新分頁。
  const focusOrOpen = (s: SshSession) => {
    const key = live.get(s.id);
    if (!key) { open(s); return; }
    useStore.getState().setActiveTab(key);
  };

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

  const renderSession = (s: SshSession, depth: number) => {
    const connected = live.has(s.id);
    const ftp = isFtpHost(s);
    return (
      <div
        key={s.id}
        tabIndex={0}
        role="treeitem"
        data-ssh-host={s.id}
        data-connected={connected ? "" : undefined}
        onClick={() => setSelected(s.id)}
        onDoubleClick={() => open(s)}
        onKeyDown={(e) => onRowKey(e, s)}
        onContextMenu={(e) => { e.preventDefault(); setSelected(s.id); setMenu({ x: e.clientX, y: e.clientY, session: s }); }}
        title={ftp ? `ftp://${s.username ? `${s.username}@` : ""}${s.host}:${s.port}` : `${s.username}@${s.host}:${s.port}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        className={`group flex items-center gap-1.5 pr-2 py-1 cursor-pointer select-none outline-none ${selected === s.id ? "bg-accent/15" : "hover:bg-fg/5"}`}
      >
        {/* 同資料庫連線：已連線＝亮色、未連線＝灰暗。 */}
        <span className={`shrink-0 flex ${connected ? "text-emerald-400" : "text-fg/35"}`} title={connected ? t("已連線") : t("未連線")}>
          <Icon icon={ftp ? FolderOpen : SquareTerminal} size={13} />
        </span>
        <span className="truncate flex-1">{sessionLabel(s)}</span>
        {s.name && <span className="text-[10px] text-fg/30 truncate max-w-[110px] mono group-hover:hidden">{s.username}@{s.host}</span>}
        {ftp ? (
          <>
            <RowButton icon={FolderOpen} label={connected ? t("切到分頁") : t("開啟")} onClick={() => focusOrOpen(s)} />
            <RowButton icon={AppWindow} label={t("在獨立視窗開啟")} onClick={() => openSftp(s)} />
          </>
        ) : (
          <>
            <RowButton icon={SquareTerminal} label={connected ? t("切到終端機") : t("開啟終端機")} onClick={() => focusOrOpen(s)} />
            <RowButton icon={FolderOpen} label={t("開啟 SFTP")} onClick={() => openSftp(s)} />
          </>
        )}
        <RowButton icon={Pencil} label={ftp ? t("編輯 FTP 主機") : t("編輯 SSH 主機")} onClick={() => onEdit(s, s.folder_id)} />
      </div>
    );
  };

  const total = sessions.length;
  const showBody = !collapsed || !!q;

  // 一台都沒有（含還在載入）就整個不顯示；有了第一台才出現。
  if (total === 0) return null;

  return (
    <div className="border-t border-fg/10 py-1" data-ssh-host-tree="">
      <div
        className="group px-2 py-1 text-[10px] uppercase tracking-wide text-fg/35 flex items-center gap-1 cursor-pointer select-none"
        onClick={toggleSection}
      >
        <Icon icon={showBody ? ChevronDown : ChevronRight} size={11} className="text-fg/40" />
        <span>{t("SSH 主機")}{total ? ` (${total})` : ""}</span>
        <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button type="button" onClick={(e) => { e.stopPropagation(); setImportOpen(true); }} title={t("匯入主機（~/.ssh/config、.xsh 工作階段）")} aria-label={t("匯入 SSH 主機")}
            className="w-5 h-5 grid place-items-center rounded text-fg/40 hover:text-fg/80 hover:bg-fg/10">
            <Icon icon={FileInput} size={12} />
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); setKeysOpen(true); }} title={t("SSH 金鑰（匯入 / 產生 / 憑證）")} aria-label={t("SSH 金鑰")}
            className="w-5 h-5 grid place-items-center rounded text-fg/40 hover:text-fg/80 hover:bg-fg/10">
            <Icon icon={KeyRound} size={12} />
          </button>
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
        </div>
      )}

      {menu && (
        <MenuPanel x={menu.x} y={menu.y} minW={170} onClose={() => setMenu(null)}>
          {(menu.session
            ? ([
                [t("連線"), () => open(menu.session!), false],
                [isFtpHost(menu.session) ? t("在獨立視窗開啟") : t("開啟 SFTP"), () => openSftp(menu.session!), false],
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
      {keysOpen && (
        <Suspense fallback={null}>
          <SshKeyManager open onClose={() => setKeysOpen(false)} />
        </Suspense>
      )}
      {importOpen && (
        <Suspense fallback={null}>
          <SshImportDialog open onClose={() => setImportOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

/** 主機列滑過才出現的小按鈕（樣式對齊資料庫連線列的編輯 / 刪除）。雙擊不往上冒，免得又觸發整列的「連線」。 */
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
