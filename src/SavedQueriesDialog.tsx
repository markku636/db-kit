import { useMemo, useState } from "react";
import { Star, Plus, Upload, Download, Trash2, Pencil, ArrowLeft, Search, FileCode2 } from "lucide-react";
import { api } from "./api";
import { toast, uiConfirm, pickSaveFile, pickOpenFile } from "./ui";
import { Modal, Button, Input, Textarea } from "./ui/index";
import Icon from "./ui/Icon";
import { useStore } from "./store";
import {
  savedQueryGroups,
  buildSqlLibraryBundle,
  parseSqlLibraryBundle,
  mergeSavedQueries,
  countSavedQueryConflicts,
  fmtRelativeTime,
  type SavedQuery,
} from "./sql";

// 收藏查詢管理視窗（清單 ↔ 編輯兩模式，對標 RoutinesDialog）：
// 分組清單 + 搜尋 + 新增 / 編輯 / 重新命名 / 刪除 + 捲軸 SQL 區 + 匯出 / 匯入（含 SQL 片段）。
// 所有狀態來自反應式 store slice，故側欄與編輯器同步更新。

const UNGROUPED = "（未分組）";
const GROUPS_LIST_ID = "saved-query-groups";

export interface SavedQueriesDialogProps {
  onClose: () => void;
  // 由編輯器「收藏目前查詢…」帶入：非 null 時直接開「新增」編輯模式、SQL 預填、名稱空白。
  seedSql?: string | null;
  // 由側欄「編輯」帶入：非 null 時直接開該筆「編輯」模式。
  editName?: string | null;
}

export default function SavedQueriesDialog({ onClose, seedSql, editName }: SavedQueriesDialogProps) {
  const savedQueries = useStore((s) => s.savedQueries);
  const snippets = useStore((s) => s.snippets);

  // 初始意圖（只在掛載時判定；視窗每次開啟都重新掛載）。
  const initEdit = editName ? savedQueries.find((x) => x.name === editName) ?? null : null;
  const [mode, setMode] = useState<"list" | "editor">(seedSql != null || initEdit ? "editor" : "list");
  const [editingName, setEditingName] = useState<string | null>(initEdit ? initEdit.name : null); // 編輯既有時的舊名；新增為 null
  const [fName, setFName] = useState(initEdit?.name ?? "");
  const [fGroup, setFGroup] = useState(initEdit?.group ?? "");
  const [fDesc, setFDesc] = useState(initEdit?.desc ?? "");
  const [fSql, setFSql] = useState(seedSql ?? initEdit?.sql ?? "");
  const [search, setSearch] = useState("");

  const groups = useMemo(() => savedQueryGroups(savedQueries), [savedQueries]);

  // 過濾 + 依 group 分組（未分組置底、組內依名稱排序）。
  const grouped = useMemo(() => {
    const t = search.trim().toLowerCase();
    const list = t
      ? savedQueries.filter(
          (q) =>
            q.name.toLowerCase().includes(t) ||
            (q.desc ?? "").toLowerCase().includes(t) ||
            q.sql.toLowerCase().includes(t),
        )
      : savedQueries;
    const map = new Map<string, SavedQuery[]>();
    for (const q of list) {
      const g = q.group?.trim() || "";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(q);
    }
    const named = [...map.keys()].filter((g) => g).sort((a, b) => a.localeCompare(b));
    const order = map.has("") ? [...named, ""] : named;
    return order.map((g) => ({
      group: g,
      label: g || UNGROUPED,
      items: map.get(g)!.slice().sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [savedQueries, search]);

  const openNew = (sql = "") => {
    setEditingName(null);
    setFName("");
    setFGroup("");
    setFDesc("");
    setFSql(sql);
    setMode("editor");
  };
  const openEdit = (q: SavedQuery) => {
    setEditingName(q.name);
    setFName(q.name);
    setFGroup(q.group ?? "");
    setFDesc(q.desc ?? "");
    setFSql(q.sql);
    setMode("editor");
  };

  const save = async () => {
    const name = fName.trim();
    const sql = fSql.trim();
    if (!name) {
      toast.info("請輸入名稱");
      return;
    }
    if (!sql) {
      toast.info("SQL 不可為空");
      return;
    }
    const payload: SavedQuery = {
      name,
      sql,
      ...(fGroup.trim() ? { group: fGroup.trim() } : {}),
      ...(fDesc.trim() ? { desc: fDesc.trim() } : {}),
    };
    // 名稱撞到「另一筆」既有收藏 → 先確認覆蓋。
    const collides = editingName !== name && savedQueries.some((q) => q.name === name);
    if (collides) {
      const ok = await uiConfirm(`已有名為「${name}」的收藏，要覆蓋它嗎？`, {
        title: "名稱重複",
        danger: true,
        confirmText: "覆蓋",
      });
      if (!ok) return;
    }
    if (editingName === null) useStore.getState().addSavedQuery(payload);
    else useStore.getState().updateSavedQuery(editingName, payload);
    toast.success(editingName === null ? "已收藏" : "已更新");
    setMode("list");
  };

  const del = async (q: SavedQuery) => {
    const ok = await uiConfirm(`刪除收藏「${q.name}」？此動作無法復原。`, {
      title: "刪除收藏",
      danger: true,
      confirmText: "刪除",
    });
    if (!ok) return;
    useStore.getState().removeSavedQuery(q.name);
    toast.success("已刪除");
  };

  const loadToEditor = (q: SavedQuery) => {
    useStore.getState().requestQuery(q.sql);
    onClose();
  };

  const exportLibrary = async () => {
    const bundle = buildSqlLibraryBundle(savedQueries, snippets, Date.now());
    if (bundle.savedQueries.length === 0 && bundle.snippets.length === 0) {
      toast.info("沒有可匯出的收藏或片段");
      return;
    }
    const path = await pickSaveFile("db-kit-sql-library.json", [{ name: "db-kit SQL 庫", extensions: ["json"] }]);
    if (!path) return;
    try {
      await api.saveTextFile(path, JSON.stringify(bundle, null, 2));
      toast.success(`已匯出 ${bundle.savedQueries.length} 收藏、${bundle.snippets.length} 片段`);
    } catch (e: any) {
      toast.error(e?.message ?? "匯出失敗");
    }
  };

  const importLibrary = async () => {
    const path = await pickOpenFile([{ name: "db-kit SQL 庫", extensions: ["json"] }]);
    if (!path) return;
    let parsed: ReturnType<typeof parseSqlLibraryBundle>;
    try {
      parsed = parseSqlLibraryBundle(await api.readTextFile(path));
    } catch (e: any) {
      toast.error(e?.message ?? "匯入失敗：檔案無法解析");
      return;
    }
    const incQ = parsed.savedQueries;
    const incS = parsed.snippets;
    if (incQ.length === 0 && incS.length === 0) {
      toast.info("檔案內沒有收藏或片段");
      return;
    }
    // 既有使用者片段（不含 builtin）與名稱集，用於片段衝突偵測。
    const existingUser = snippets.filter((s) => !s.builtin).map((s) => ({ name: s.name, body: s.body, desc: s.desc }));
    const existingSnipNames = new Set(existingUser.map((s) => s.name));
    // 同名衝突 → 一次詢問覆蓋 / 略過，決定同時套用到收藏與片段（兩者行為一致，避免片段被靜默覆蓋）。
    const qConflicts = countSavedQueryConflicts(savedQueries, incQ);
    const sConflicts = incS.reduce((n, s) => (existingSnipNames.has(s.name) ? n + 1 : n), 0);
    const conflicts = qConflicts + sConflicts;
    let overwrite = true;
    if (conflicts > 0) {
      overwrite = await uiConfirm(
        `匯入含 ${conflicts} 筆同名項目（收藏 ${qConflicts}、片段 ${sConflicts}）。要覆蓋既有嗎？（確定＝覆蓋、取消＝略過同名）`,
        { title: "匯入 SQL 庫", confirmText: "覆蓋" },
      );
    }
    if (incQ.length > 0) {
      useStore.getState().replaceSavedQueries(mergeSavedQueries(savedQueries, incQ, overwrite));
    }
    if (incS.length > 0) {
      // replaceSnippets 內部 mergeSnippets「後者覆蓋前者」：覆蓋 → 匯入者置後勝出；略過 → 既有置後勝出（新項仍加入）。
      const mergedUser = overwrite ? [...existingUser, ...incS] : [...incS, ...existingUser];
      useStore.getState().replaceSnippets(mergedUser);
    }
    // 回報「實際套用」數（略過同名時不灌水）。
    const appliedQ = overwrite ? incQ.length : incQ.length - qConflicts;
    const appliedS = overwrite ? incS.length : incS.length - sConflicts;
    const skipped = overwrite ? 0 : conflicts;
    toast.success(`已匯入 ${appliedQ} 收藏、${appliedS} 片段${skipped ? `（略過 ${skipped} 筆同名）` : ""}`);
  };

  // ---- 編輯模式 ----
  if (mode === "editor") {
    const isNew = editingName === null;
    return (
      <Modal
        onClose={onClose}
        icon={Star}
        size="lg"
        className="!w-[760px] max-w-[94vw] h-[80vh]"
        bodyClassName="p-0 flex flex-col min-h-0"
        title={
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode("list")}
              className="inline-flex items-center gap-1 text-xs text-fg/50 hover:text-fg/80"
              title="返回清單"
            >
              <Icon icon={ArrowLeft} size={14} />
            </button>
            <span>{isNew ? "新增收藏查詢" : `編輯收藏：${editingName}`}</span>
          </span>
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setMode("list")}>
              取消
            </Button>
            <Button variant="primary" onClick={save}>
              儲存
            </Button>
          </>
        }
      >
        <datalist id={GROUPS_LIST_ID}>
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        <div className="flex flex-col min-h-0 flex-1 p-4 gap-3">
          <div className="grid grid-cols-[1fr_1fr] gap-3 shrink-0">
            <label className="grid gap-1">
              <span className="text-xs text-fg/60">名稱</span>
              <Input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="例如：每日活躍用戶" autoFocus />
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-fg/60">分組（可留空）</span>
              <Input
                value={fGroup}
                onChange={(e) => setFGroup(e.target.value)}
                list={GROUPS_LIST_ID}
                placeholder="例如：金流串接"
              />
            </label>
          </div>
          <label className="grid gap-1 shrink-0">
            <span className="text-xs text-fg/60">說明（可留空）</span>
            <Input value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder="這段查詢的用途" />
          </label>
          <label className="flex flex-col gap-1 flex-1 min-h-0">
            <span className="text-xs text-fg/60">SQL（可捲動；長查詢也能完整檢視）</span>
            <Textarea
              value={fSql}
              onChange={(e) => setFSql(e.target.value)}
              spellCheck={false}
              wrap="off"
              className="flex-1 min-h-0 resize-none overflow-auto font-mono text-[12px] leading-relaxed whitespace-pre"
              placeholder="SELECT ..."
            />
          </label>
        </div>
      </Modal>
    );
  }

  // ---- 清單模式 ----
  const total = savedQueries.length;
  return (
    <Modal
      onClose={onClose}
      icon={Star}
      size="lg"
      className="!w-[760px] max-w-[94vw] h-[80vh]"
      bodyClassName="p-0 flex flex-col min-h-0"
      title={
        <span className="flex items-center gap-2">
          <span>收藏查詢</span>
          <span className="text-xs text-fg/40 font-normal">{total} 筆</span>
        </span>
      }
    >
      {/* 工具列：搜尋 + 新增 / 匯入 / 匯出 */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-fg/10">
        <div className="relative flex-1">
          <Icon icon={Search} size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg/35" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋名稱 / 說明 / SQL…"
            className="pl-8"
          />
        </div>
        <Button variant="primary" icon={Plus} onClick={() => openNew()}>
          新增
        </Button>
        <Button variant="secondary" icon={Upload} onClick={importLibrary} title="從檔案匯入收藏與片段">
          匯入
        </Button>
        <Button variant="secondary" icon={Download} onClick={exportLibrary} title="匯出收藏與片段為 JSON 檔">
          匯出
        </Button>
      </div>

      {/* 清單（分組、可捲動） */}
      <div className="flex-1 overflow-auto min-h-0">
        {total === 0 ? (
          <div className="h-full grid place-items-center text-center text-fg/40 text-sm px-6">
            <div>
              <Icon icon={Star} size={28} className="mx-auto mb-2 text-fg/25" />
              尚無收藏查詢。
              <div className="mt-1 text-xs text-fg/35">在查詢編輯器按「收藏目前查詢…」，或點上方「新增」、「匯入」。</div>
            </div>
          </div>
        ) : grouped.length === 0 ? (
          <div className="p-6 text-center text-fg/40 text-sm">找不到符合「{search}」的收藏。</div>
        ) : (
          grouped.map(({ group, label, items }) => (
            <div key={group || "__ungrouped__"}>
              <div className="sticky top-0 z-[1] bg-elevated/95 backdrop-blur px-4 py-1.5 text-[11px] font-medium text-fg/45 border-b border-fg/5 flex items-center gap-1.5">
                <Icon icon={FileCode2} size={12} className="text-blue-300/70" />
                {label}
                <span className="text-fg/30">（{items.length}）</span>
              </div>
              {items.map((q) => (
                <div key={q.name} className="group flex items-start gap-2 px-4 py-2 hover:bg-fg/[0.04] border-b border-fg/5">
                  <button
                    type="button"
                    onDoubleClick={() => loadToEditor(q)}
                    onClick={() => openEdit(q)}
                    className="flex-1 min-w-0 text-left"
                    title="點一下編輯、雙擊載入到編輯器"
                  >
                    <div className="flex items-center gap-1.5 text-sm">
                      <Icon icon={Star} size={12} className="text-amber-300 shrink-0" />
                      <span className="truncate font-medium text-fg/85">{q.name}</span>
                      {q.updatedAt ? (
                        <span className="ml-1 text-[10px] text-fg/30 shrink-0">{fmtRelativeTime(q.updatedAt)}</span>
                      ) : null}
                    </div>
                    {q.desc && <div className="mt-0.5 text-[11px] text-fg/45 truncate">{q.desc}</div>}
                    <div className="mt-0.5 text-[11px] text-fg/35 font-mono truncate">{q.sql.replace(/\s+/g, " ").trim()}</div>
                  </button>
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={() => loadToEditor(q)}
                      title="載入到編輯器"
                      className="w-7 h-7 grid place-items-center rounded text-fg/45 hover:text-accent hover:bg-fg/10"
                    >
                      <Icon icon={FileCode2} size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(q)}
                      title="編輯"
                      className="w-7 h-7 grid place-items-center rounded text-fg/45 hover:text-fg hover:bg-fg/10"
                    >
                      <Icon icon={Pencil} size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => del(q)}
                      title="刪除"
                      className="w-7 h-7 grid place-items-center rounded text-fg/45 hover:text-red-400 hover:bg-fg/10"
                    >
                      <Icon icon={Trash2} size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
