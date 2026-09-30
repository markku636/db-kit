// 側欄的「遠端桌面」區塊：群組 + RDP / VNC / RustDesk 主機（與 SSH 主機分開存、分開顯示）。
// 分組行為（區塊標題、群組、拖曳排序、搬移）與資料庫連線、SSH 主機共用 sidebar/GroupedSection。
// 單擊高亮、雙擊 / Enter 開遠端桌面分頁；右鍵有連線 / 全螢幕連線 / 編輯 / 複製 / 移到群組 / 刪除。
// 一台都沒有時整個區塊不顯示（同 SSH）：新增走「新增連線 → 遠端主機」、貼 rdp:// vnc:// rustdesk:// 字串或匯入 .rdp。
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Expand, FileInput, Pencil } from "lucide-react";
import { useT } from "./i18n";
import { Icon, MenuPanel } from "./ui/index";
import { toast, uiConfirm } from "./ui";
import { useStore } from "./store";
import type { RdFolder, RdSession } from "./rdTypes";
import { filterRdSessions, rdEndpoint, rdProtocolLabel, rdSessionLabel, useRdSessions } from "./rdSessions";
import { RD_META, useRdStatus } from "./rdStatus";
import GroupedSection, { HeaderButton, RowButton, moveTargets, type ItemDnd } from "./sidebar/GroupedSection";
import { moveItem, type Placement } from "./sidebarGroups";

const SECTION_KEY = "db-kit:rdSectionCollapsed";
const FOLDERS_KEY = "db-kit:rdFoldersCollapsed";

export interface RdHostTreeProps {
  /** 側欄搜尋字（已 trim + lowercase）；非空時全展開、只顯示命中的主機。 */
  q: string;
  onOpen: (s: RdSession, opts?: { fullscreen?: boolean }) => void;
  onEdit: (s: RdSession | null, folderId?: string | null) => void;
  /** 匯入 .rdp 連線檔（開檔案對話框 → 帶入主機對話框）。 */
  onImportRdp: () => void;
}

const err = (e: unknown) => toast.error(String((e as Error)?.message ?? e));

export default function RdHostTree({ q, onOpen, onEdit, onImportRdp }: RdHostTreeProps) {
  const t = useT();
  const folders = useRdSessions((s) => s.folders);
  const sessions = useRdSessions((s) => s.sessions);
  const loaded = useRdSessions((s) => s.loaded);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; session: RdSession } | null>(null);

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

  const matched = useMemo(() => (q ? new Set(filterRdSessions(sessions, q).map((s) => s.id)) : null), [sessions, q]);

  // 已連線就切到那個分頁，不另開一條；沒連線才開新分頁。
  const focusOrOpen = (s: RdSession, fullscreen = false) => {
    const key = live.get(s.id);
    if (key && !fullscreen) { useStore.getState().setActiveTab(key); return; }
    onOpen(s, { fullscreen });
  };

  const applyLayout = (placements: Placement[], next: RdFolder[]) =>
    void useRdSessions.getState().applyLayout(next, placements).catch(err);
  const moveTo = (s: RdSession, folderId: string | null) =>
    applyLayout(moveItem(sessions.map((x) => ({ id: x.id, groupId: x.folder_id ?? null })), folders, s.id, folderId, Number.MAX_SAFE_INTEGER), folders);

  const removeSession = async (s: RdSession) => {
    const ok = await uiConfirm(t("刪除遠端桌面「{name}」？儲存的密碼也會一併移除。", { name: rdSessionLabel(s) }), { title: t("刪除遠端桌面"), danger: true, confirmText: t("刪除") });
    if (!ok) return;
    try { await useRdSessions.getState().remove(s.id); } catch (e) { err(e); }
  };
  const duplicate = (s: RdSession) => onEdit({ ...s, id: crypto.randomUUID(), name: s.name ? `${s.name} (2)` : "" }, s.folder_id);

  const onRowKey = (e: ReactKeyboardEvent, s: RdSession) => {
    if (e.key === "Enter") { e.preventDefault(); focusOrOpen(s); }
  };

  const renderSession = (s: RdSession, dnd: ItemDnd) => {
    const connected = live.has(s.id);
    const meta = RD_META[s.protocol];
    return (
      <div
        {...dnd.rowProps}
        tabIndex={0}
        role="treeitem"
        data-rd-host={s.id}
        data-connected={connected ? "" : undefined}
        onClick={() => setSelected(s.id)}
        onDoubleClick={() => focusOrOpen(s)}
        onKeyDown={(e) => onRowKey(e, s)}
        onContextMenu={(e) => { e.preventDefault(); setSelected(s.id); setMenu({ x: e.clientX, y: e.clientY, session: s }); }}
        title={`${rdProtocolLabel(s.protocol)} · ${s.username ? `${s.username}@` : ""}${rdEndpoint(s)}`}
        className={`group flex items-center gap-1.5 pl-3 pr-2 py-1 cursor-pointer select-none outline-none ${selected === s.id ? "bg-accent/15" : "hover:bg-fg/5"} ${dnd.rowClass}`}
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

  if (sessions.length === 0) return null;

  return (
    <>
      <GroupedSection<RdSession, RdFolder>
        title={t("遠端桌面")}
        collapseKey={SECTION_KEY}
        groupCollapseKey={FOLDERS_KEY}
        className="border-t border-fg/10 py-1"
        dataAttrs={{ "data-rd-host-tree": "" }}
        actions={<HeaderButton icon={FileInput} label={t("匯入 .rdp 連線檔")} onClick={onImportRdp} />}
        newItemLabel={t("新增遠端桌面")}
        onNewItem={(gid) => onEdit(null, gid)}
        groups={folders}
        items={sessions}
        groupOf={(s) => s.folder_id}
        visible={matched ? (s) => matched.has(s.id) : undefined}
        q={q}
        renderItem={renderSession}
        makeGroup={(id, name) => ({ id, name, parent_id: null })}
        onLayout={applyLayout}
      />

      {menu && (
        <MenuPanel x={menu.x} y={menu.y} minW={170} onClose={() => setMenu(null)}>
          {([
            [t("連線"), () => focusOrOpen(menu.session), false],
            [t("全螢幕連線"), () => focusOrOpen(menu.session, true), false],
            [t("編輯…"), () => onEdit(menu.session, menu.session.folder_id), false],
            [t("複製"), () => duplicate(menu.session), false],
            ...moveTargets(folders, menu.session.folder_id, t).map(([label, gid]) => [label, () => moveTo(menu.session, gid), false]),
            [t("刪除"), () => void removeSession(menu.session), true],
          ] as [string, () => void, boolean][]).map(([label, fn, danger]) => (
            <button key={label} type="button"
              onClick={() => { setMenu(null); fn(); }}
              className={`block w-full text-left px-3 py-1.5 hover:bg-fg/10 ${danger ? "text-danger" : "text-fg/80"}`}>
              {label}
            </button>
          ))}
        </MenuPanel>
      )}
    </>
  );
}
