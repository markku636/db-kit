// 側欄的一個「型態」區塊（某種資料庫、SSH 主機、遠端桌面）：可摺疊的區塊標題 + 自訂群組 + 項目。
// 三種連線共用這一個元件，分組行為因此一致：
// - 區塊標題：點一下整區收起（記在 localStorage），滑過出現按鈕（呼叫端的 + 內建的「新增群組」「新增…」）；
// - 群組列：箭頭 + 資料夾圖示 + 名稱（右鍵 → 重新命名時變成輸入框）+ 數量 + 滑過的刪除鈕；
// - 群組成員縮一層，未分組的項目直接排在所有群組之後（不另立「未分組」標題）；
// - 拖曳：項目排序、拖進群組、拖到區塊標題 = 移出群組、拖群組列 = 群組換位；
// - 搜尋時整區與群組一律展開，沒有命中的群組不佔版面。
// 項目本身怎麼畫、右鍵選單有什麼，由呼叫端的 renderItem 決定；排版變更一律經 onLayout 交回呼叫端落地。
//
// ⚠️ HTML5 拖曳依賴 tauri.conf.json 的 `app.windows[].dragDropEnabled: false`。Tauri v2 預設為 true，
// webview 會攔截原生 drag-drop（用來接「從檔案總管拖檔進來」），副作用是頁面內完全收不到 dragover / drop——
// Tauri 官方 schema 明載「Disabling it is required to use HTML5 drag and drop on the frontend on Windows」。
import { Fragment, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, FolderPlus, Plus, Trash2, type LucideIcon } from "lucide-react";
import { useT, type t as TFn } from "../i18n";
import { Icon, MenuPanel } from "../ui/index";
import { uiConfirm } from "../ui";
import {
  deleteGroupFrom, loadSet, moveGroup, moveItem, moveItemNextTo, saveSet, sectionize, uniqueGroupName,
  type GroupLike, type Placement,
} from "../sidebarGroups";

/** 交給 renderItem 的拖曳接線：rowProps 掛在「項目那一列」上（不要掛在包含展開子樹的外層）。 */
export interface ItemDnd {
  rowProps: {
    draggable: boolean;
    onDragStart: (e: ReactDragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (e: ReactDragEvent) => void;
    onDrop: (e: ReactDragEvent) => void;
  };
  /** 落點指示線 / 拖曳中半透明，接在該列的 className 後面。 */
  rowClass: string;
}

export interface GroupedSectionProps<T extends { id: string }, G extends GroupLike> {
  /** 區塊名稱（例如「PostgreSQL」「SSH 主機」），後面自動接 (數量)。 */
  title: string;
  icon?: ReactNode;
  /** 整區摺疊狀態的 localStorage 鍵（值 "1" / "0"）。 */
  collapseKey: string;
  /** 已摺疊群組 id 集合的 localStorage 鍵。多個區塊可以共用同一個鍵（群組 id 不會撞號）。 */
  groupCollapseKey: string;
  className?: string;
  /** 掛在區塊外層的 data-* 屬性（測試定位用）。 */
  dataAttrs?: Record<string, string>;
  /** 區塊標題滑過時出現的額外按鈕（放在「新增群組」「新增…」前面）。 */
  actions?: ReactNode;
  /** 「新增…」按鈕與群組右鍵選單的文字，例如「新增 SSH 主機」。沒給 onNewItem 就不顯示。 */
  newItemLabel?: string;
  /** groupId = 從群組右鍵選單新增時，新項目要放進的群組；從區塊標題新增則為 null。 */
  onNewItem?: (groupId: string | null) => void;
  groups: G[];
  /** 項目，陣列順序＝顯示順序。 */
  items: T[];
  groupOf: (t: T) => string | null | undefined;
  /** 搜尋過濾；未給 = 全部顯示。 */
  visible?: (t: T) => boolean;
  /** 側欄搜尋字（已 trim + lowercase）。 */
  q: string;
  renderItem: (t: T, dnd: ItemDnd) => ReactNode;
  /** 新群組物件（DB 要帶 kind、SSH / RD 要帶 parent_id）。 */
  makeGroup: (id: string, name: string) => G;
  /** 排版變更（排序 / 搬移 / 新增、改名、刪除群組）：呼叫端先更新畫面再落地，失敗自行回滾與提示。 */
  onLayout: (placements: Placement[], groups: G[]) => void;
}

type DropAt =
  | { kind: "item" | "group"; id: string; before: boolean }
  | { kind: "into"; id: string | null };

const dropHalf = (e: ReactDragEvent) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2;
};

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function GroupedSection<T extends { id: string }, G extends GroupLike>(p: GroupedSectionProps<T, G>) {
  const t = useT();
  const { q, groups, items } = p;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(p.collapseKey) === "1"; } catch { return false; }
  });
  const [closed, setClosed] = useState<Set<string>>(() => loadSet(p.groupCollapseKey));
  const [drag, setDrag] = useState<{ kind: "item" | "group"; id: string } | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [menu, setMenu] = useState<{ group: G; x: number; y: number } | null>(null);

  const placements: Placement[] = items.map((it) => ({ id: it.id, groupId: p.groupOf(it) ?? null }));
  const sections = sectionize(items, groups, p.groupOf);
  const visible = p.visible ?? (() => true);

  const setSectionCollapsed = (v: boolean) => {
    setCollapsed(v);
    try { localStorage.setItem(p.collapseKey, v ? "1" : "0"); } catch { /* 忽略 */ }
  };
  // 每次都從 localStorage 重讀再改：共用同一個鍵的其他區塊可能剛寫過，不能拿自己手上的舊集合覆蓋。
  const setGroupClosed = (id: string, value: boolean) => {
    const next = loadSet(p.groupCollapseKey);
    if (value) next.add(id); else next.delete(id);
    saveSet(p.groupCollapseKey, next);
    setClosed(next);
  };

  const addGroup = () => {
    const g = p.makeGroup(newId(), uniqueGroupName(groups, t("新群組")));
    if (collapsed) setSectionCollapsed(false); // 摺著的話改名框看不到
    p.onLayout(placements, [...groups, g]);
    // 建完直接進入改名：新群組的預設名字幾乎一定要改。
    setRenaming({ id: g.id, name: g.name });
  };

  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    const target = groups.find((g) => g.id === renaming.id);
    setRenaming(null);
    if (!target || !name || name === target.name) return;
    const unique = uniqueGroupName(groups, name, renaming.id);
    p.onLayout(placements, groups.map((g) => (g.id === renaming.id ? { ...g, name: unique } : g)));
  };

  /** 刪群組：底下有項目就先問過（項目只會移到未分組，不會被刪）。空群組直接刪。 */
  const removeGroup = async (g: G) => {
    const count = placements.filter((x) => x.groupId === g.id).length;
    if (count > 0) {
      const ok = await uiConfirm(
        t("群組「{name}」底下還有 {count} 個項目，刪除群組後它們會移到「未分組」，項目本身不會被刪除。", { name: g.name, count }),
        { title: t("刪除群組"), danger: true, confirmText: t("刪除群組") },
      );
      if (!ok) return;
    }
    const next = deleteGroupFrom(placements, groups, g.id);
    p.onLayout(next.items, next.groups);
  };

  /** 放開滑鼠：把 drag + dropAt 換算成一次排版更新（沒有變動就不落地）。 */
  const commitDrop = () => {
    const d = drag;
    const at = dropAt;
    setDrag(null);
    setDropAt(null);
    if (!d || !at) return;
    if (d.kind === "group") {
      // 群組只跟群組換位；拖到項目或群組內容上不做事。
      if (at.kind !== "group") return;
      const next = moveGroup(groups, d.id, at.id, at.before);
      if (next !== groups) p.onLayout(placements, next);
      return;
    }
    let next = placements;
    if (at.kind === "into") {
      // 拖到群組列上 → 接在該群組末端，並展開它（不然看不到東西跑哪去了）。
      if (at.id) setGroupClosed(at.id, false);
      next = moveItem(placements, groups, d.id, at.id, Number.MAX_SAFE_INTEGER);
    } else if (at.kind === "item") {
      next = moveItemNextTo(placements, groups, d.id, at.id, at.before);
    }
    const same = next.length === placements.length && next.every((x, i) => x.id === placements[i].id && x.groupId === placements[i].groupId);
    if (!same) p.onLayout(next, groups);
  };

  const endDrag = () => { setDrag(null); setDropAt(null); };

  const dndFor = (id: string): ItemDnd => {
    const line = dropAt?.kind === "item" && dropAt.id === id ? dropAt.before : null;
    return {
      rowProps: {
        draggable: !renaming,
        onDragStart: (e) => {
          setDrag({ kind: "item", id });
          e.dataTransfer.effectAllowed = "move";
          // 某些瀏覽器沒有 setData 就不會真的啟動拖曳。
          e.dataTransfer.setData("text/plain", id);
        },
        onDragEnd: endDrag,
        onDragOver: (e) => {
          if (drag?.kind !== "item") return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "move";
          // 停在自己身上＝不動作：不攔掉的話會冒泡到群組容器，變成「丟到本群組末端」。
          setDropAt(drag.id === id ? null : { kind: "item", id, before: dropHalf(e) });
        },
        onDrop: (e) => { e.preventDefault(); e.stopPropagation(); commitDrop(); },
      },
      rowClass: `${line === true ? "border-t-2 border-accent" : ""} ${line === false ? "border-b-2 border-accent" : ""} ${
        drag?.kind === "item" && drag.id === id ? "opacity-40" : ""
      }`,
    };
  };

  if (items.length === 0) return null;
  const showBody = !collapsed || !!q;
  const intoSection = dropAt?.kind === "into" && dropAt.id === null;

  return (
    <div className={p.className ?? "py-1"} {...p.dataAttrs}>
      <div
        className={`group px-2 py-1 text-[10px] uppercase tracking-wide text-fg/35 flex items-center gap-1 cursor-pointer select-none ${
          intoSection ? "bg-accent/15 outline outline-1 outline-accent/40" : ""
        }`}
        onClick={() => setSectionCollapsed(!collapsed)}
        // 拖項目到區塊標題上 → 移出群組（未分組區沒有自己的標題，這裡就是它的落點）。
        onDragOver={(e) => {
          if (drag?.kind !== "item") return;
          e.preventDefault();
          setDropAt({ kind: "into", id: null });
        }}
        onDrop={(e) => { e.preventDefault(); commitDrop(); }}
        title={t("點擊摺疊 / 展開；把項目拖到這裡可移出群組")}
      >
        <Icon icon={showBody ? ChevronDown : ChevronRight} size={11} className="text-fg/40 shrink-0" />
        {p.icon}
        <span className="truncate">{p.title} ({items.length})</span>
        <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          {p.actions}
          <HeaderButton icon={FolderPlus} label={t("新增群組")} title={t("建立群組後，把項目拖進來即可分類")} onClick={addGroup} />
          {p.onNewItem && p.newItemLabel && <HeaderButton icon={Plus} label={p.newItemLabel} onClick={() => p.onNewItem!(null)} />}
        </span>
      </div>
      {showBody && sections.map((section) => {
        const g = section.group;
        const gid = g?.id ?? null;
        const shown = section.items.filter(visible);
        // 空的具名群組要留著（它是拖放目標）；搜尋無命中的群組、以及空的未分組區則不佔版面。
        if (shown.length === 0 && (q || !g)) return null;
        // 搜尋中一律展開，否則命中的項目被摺疊藏住，搜尋等於失效。
        const isClosed = !q && !!g && closed.has(g.id);
        const dragOverInto = dropAt?.kind === "into" && dropAt.id === gid && gid !== null;
        const groupLine = g && dropAt?.kind === "group" && dropAt.id === g.id ? dropAt.before : null;
        return (
          <div
            key={`g:${gid ?? ""}`}
            data-group-section={gid ?? ""}
            // 群組內容的空白處：接受項目 → 丟進這一組。
            onDragOver={(e) => {
              if (drag?.kind !== "item") return;
              e.preventDefault();
              setDropAt({ kind: "into", id: gid });
            }}
            onDrop={(e) => { e.preventDefault(); commitDrop(); }}
          >
            {g && (
              <div
                data-group-row={g.id}
                draggable={!renaming}
                onDragStart={(e) => {
                  e.stopPropagation();
                  setDrag({ kind: "group", id: g.id });
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", g.id);
                }}
                onDragEnd={endDrag}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  e.stopPropagation();
                  // 拖群組 → 換位；拖項目 → 丟進這組。
                  if (drag.kind === "group") {
                    if (drag.id !== g.id) setDropAt({ kind: "group", id: g.id, before: dropHalf(e) });
                  } else setDropAt({ kind: "into", id: g.id });
                }}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); commitDrop(); }}
                onClick={() => setGroupClosed(g.id, !isClosed)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ group: g, x: e.clientX, y: e.clientY }); }}
                title={t("點擊摺疊 / 展開；拖曳可調整群組順序；右鍵可重新命名或刪除")}
                className={`group/hdr flex items-center gap-1.5 px-3 py-1 cursor-pointer select-none text-fg/70 hover:bg-fg/5 ${
                  dragOverInto ? "bg-accent/15 outline outline-1 outline-accent/40" : ""
                } ${groupLine === true ? "border-t-2 border-accent" : ""} ${groupLine === false ? "border-b-2 border-accent" : ""} ${
                  drag?.kind === "group" && drag.id === g.id ? "opacity-40" : ""
                }`}
              >
                <Icon icon={isClosed ? ChevronRight : ChevronDown} size={11} className="shrink-0 text-fg/40" />
                <Icon icon={Folder} size={13} className="shrink-0 text-amber-300/70" />
                {renaming && renaming.id === g.id ? (
                  <input
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: renaming.id, name: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    aria-label={t("群組名稱")}
                    className="flex-1 min-w-0 bg-inset border border-accent rounded px-1 py-0 text-xs outline-none"
                  />
                ) : (
                  <span className="truncate flex-1">{g.name}</span>
                )}
                <span className="shrink-0 text-[10px] text-fg/30 tabular-nums">{shown.length}</span>
                {!renaming && (
                  <button type="button" title={t("刪除群組")} aria-label={t("刪除群組")}
                    onClick={(e) => { e.stopPropagation(); void removeGroup(g); }}
                    className="w-4 h-4 shrink-0 items-center justify-center rounded text-fg/40 hover:bg-fg/15 hover:text-red-300 hidden group-hover/hdr:flex">
                    <Icon icon={Trash2} size={11} />
                  </button>
                )}
              </div>
            )}
            {/* 群組成員縮一層；未分組的直接排在區塊底下。 */}
            {!isClosed && (
              <div style={g ? { paddingLeft: 14 } : undefined}>
                {shown.map((it) => <Fragment key={it.id}>{p.renderItem(it, dndFor(it.id))}</Fragment>)}
              </div>
            )}
          </div>
        );
      })}

      {menu && (
        <MenuPanel x={menu.x} y={menu.y} minW={170} onClose={() => setMenu(null)}>
          {([
            ...(p.onNewItem && p.newItemLabel ? [[`${p.newItemLabel}…`, () => p.onNewItem!(menu.group.id), false]] : []),
            [t("重新命名"), () => setRenaming({ id: menu.group.id, name: menu.group.name }), false],
            [t("刪除群組"), () => void removeGroup(menu.group), true],
          ] as [string, () => void, boolean][]).map(([label, fn, danger]) => (
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

/** 區塊標題滑過才出現的小按鈕。 */
export function HeaderButton({ icon, label, title, onClick }: { icon: LucideIcon; label: string; title?: string; onClick: () => void }) {
  return (
    <button type="button" title={title ?? label} aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="w-5 h-5 grid place-items-center rounded text-fg/40 hover:text-fg/80 hover:bg-fg/10">
      <Icon icon={icon} size={12} />
    </button>
  );
}

/** 項目列滑過才出現的小按鈕。雙擊不往上冒，免得又觸發整列的「開啟」。 */
export function RowButton({ icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
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

/**
 * 項目右鍵選單的「移到「X」/ 移出群組」：列出同一區塊裡其他群組。回傳 [label, groupId]。
 */
export function moveTargets(groups: GroupLike[], current: string | null | undefined, t: typeof TFn): [string, string | null][] {
  const cur = current && groups.some((g) => g.id === current) ? current : null;
  return [
    ...groups.filter((g) => g.id !== cur).map((g) => [t("移到「{name}」", { name: g.name }), g.id] as [string, string | null]),
    ...(cur ? [[t("移出群組"), null] as [string, string | null]] : []),
  ];
}
