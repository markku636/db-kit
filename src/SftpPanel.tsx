// SFTP 檔案瀏覽：掛在 SSH 終端機分頁右側的分割面板（WinSCP 式並排，而非 Xshell 另開 Xftp 視窗）。
// 用同一條 SSH 連線開 sftp subsystem，不會再問一次密碼 / OTP；「在終端機 cd 到此」也因此指向同一個 shell。
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowUp, ChevronRight, Download, EyeOff, File, FilePlus, Folder, FolderPlus, FolderUp, Link2, ListFilter, Pencil, RefreshCw, Upload, X, Eye,
} from "lucide-react";
import { api } from "./api";
import type { SftpEntry, SftpOnConflict } from "./sshTypes";
import { sftpLastPath, useSshTerminals } from "./sshTerminals";
import { ensureSftpProgressListener, useSshTransfers } from "./useSshTransfers";
import { useT } from "./i18n";
import { Icon, IconButton, MenuPanel, Spinner } from "./ui/index";
import { copyToClipboard, pickDirectory, pickOpenFiles, pickSaveFile, toast, uiChoose, uiConfirm, uiPrompt } from "./ui";
import { fmtBytes } from "./schemaCache";
import { canOpenInEditor, toOctal } from "./sftpText";
import {
  EMPTY_SELECTION, clickSelect, contextSelect, moveSelect, pruneSelection, selectAll, type Selection,
} from "./sftpSelection";

// 編輯器帶 CodeMirror + 語言包、權限對話框用得少：都只在第一次打開時才下載。
const SftpFileEditor = lazy(() => import("./SftpFileEditor"));
const SftpPermsDialog = lazy(() => import("./SftpPermsDialog"));

export interface SftpPanelProps {
  tabKey: string;
  connId: string;
  /** 「在終端機 cd 到此」：由宿主送 `cd '<path>'` 進 shell。 */
  onCd: (path: string) => void;
  onClose: () => void;
}

type SortCol = "name" | "size" | "mtime";

/** 每個終端機分頁的 SFTP 目前路徑（面板卸載後仍記得；分頁關閉時由 teardownSshTab 清掉）。 */
const lastPathByTab = sftpLastPath;

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
function parentOf(path: string): string {
  if (path === "/" || !path) return "/";
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}
function baseName(p: string): string {
  const m = /[^\\/]+$/.exec(p);
  return m ? m[0] : p;
}
function fmtMtime(sec: number | null): string {
  if (sec == null) return "";
  try { return new Date(sec * 1000).toLocaleString(undefined, { hour12: false }); } catch { return ""; }
}
/** 資料夾，或指向資料夾的 symlink（下載時整棵傳、雙擊時進入）。 */
function isDirEntry(e: SftpEntry): boolean {
  return e.is_dir || e.link_target_is_dir === true;
}

export default function SftpPanel({ tabKey, connId, onCd, onClose }: SftpPanelProps) {
  const t = useT();
  const sftpId = useSshTerminals((s) => s.rt[tabKey]?.sftpId ?? null);
  const status = useSshTerminals((s) => s.rt[tabKey]?.status);
  const patch = useSshTerminals((s) => s.patch);
  const jobs = useSshTransfers((s) => s.jobs);
  // 關掉面板再打開要回到原本的資料夾：路徑記在模組層（以分頁為鍵），不隨元件卸載消失。
  const [path, setPath] = useState<string>(() => lastPathByTab.get(tabKey) ?? "/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<{ col: SortCol; dir: 1 | -1 }>({ col: "name", dir: 1 });
  // 多選（檔案總管 / Xftp 慣例）：單擊只選這一個、Ctrl 單擊切換、Shift 單擊選一段、Ctrl+A 全選。
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  // 右鍵選單：entry = 點在哪一列（null = 空白處）；targets = 這次操作的對象（右鍵點在選取裡就是整組）。
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SftpEntry | null; targets: SftpEntry[] } | null>(null);
  // App 內編輯 / 權限對話框的對象（null = 沒開）。
  const [editing, setEditing] = useState<Pick<SftpEntry, "path" | "name" | "size" | "mtime"> | null>(null);
  const [permsFor, setPermsFor] = useState<SftpEntry | null>(null);
  // 清單篩選（只過濾目前這一層的名稱，不遞迴搜尋）。
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const openingRef = useRef<string | null>(null);
  // 已經列過的 sftpId：自己剛開好的那個不要被 effect 再列一次（那次會拿舊的 path 蓋掉家目錄）。
  const listedRef = useRef<string | null>(null);
  // 列目錄的序號：快速連點兩個資料夾時，較晚回來的舊請求不能蓋掉較新的結果。
  const seqRef = useRef(0);
  const pathRef = useRef(path);
  // 方向鍵移動後把錨點那一列捲進畫面（滑鼠點的本來就看得到，不捲）。
  const kbScrollRef = useRef(false);
  // 傳輸結束的回呼可能在面板關掉、換了資料夾之後才來：只有還停在同一個資料夾才重列。
  const mountedRef = useRef(true);
  const sftpIdRef = useRef(sftpId);
  useEffect(() => { sftpIdRef.current = sftpId; }, [sftpId]);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const list = useCallback(async (id: string, p: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const es = await api.sshSftpList(id, p);
      if (seq !== seqRef.current) return;
      setEntries(es);
      // 同一個資料夾重新整理（上傳完、刪除後）保留選取裡還在的項目；換資料夾才清空。
      setSel((cur) => (p === pathRef.current ? pruneSelection(cur, es.map((x) => x.name)) : EMPTY_SELECTION));
      pathRef.current = p;
      setPath(p);
      lastPathByTab.set(tabKey, p);
    } catch (e) {
      if (seq === seqRef.current) setError(errMsg(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [tabKey]);

  // 開啟 sftp subsystem：connId 換了（重連）就重開，從家目錄開始；已有 sftpId（面板關掉又打開）則回到上次的資料夾。
  useEffect(() => {
    void ensureSftpProgressListener();
    if (status !== "connected") return;
    if (sftpId) {
      if (listedRef.current !== sftpId) { listedRef.current = sftpId; void list(sftpId, path); }
      return;
    }
    if (openingRef.current === connId) return;
    openingRef.current = connId;
    (async () => {
      try {
        const info = await api.sshSftpOpen(connId);
        // 先標記再 patch：patch 會觸發這個 effect 重跑，那次要認得「這個 sftpId 已經在列了」。
        listedRef.current = info.sftp_id;
        patch(tabKey, { sftpId: info.sftp_id });
        await list(info.sftp_id, info.home || "/");
      } catch (e) {
        setError(errMsg(e));
      } finally {
        openingRef.current = null;
      }
    })();
    // 只在連線 / sftp 狀態變動時跑；path 由 navigate 自己管。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, sftpId, status]);

  const navigate = (p: string) => { if (sftpId) void list(sftpId, p || "/"); };
  const refresh = () => navigate(path);
  /** 傳輸結束後重列 `dir`——前提是面板還開著、而且還停在那個資料夾。 */
  const refreshIfStillIn = (dir: string) => () => {
    const id = sftpIdRef.current;
    if (mountedRef.current && id && pathRef.current === dir) void list(id, dir);
  };

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = entries.filter((e) => (showHidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)));
    const cmp = (a: SftpEntry, b: SftpEntry) => {
      const da = isDirEntry(a) ? 0 : 1;
      const db = isDirEntry(b) ? 0 : 1;
      if (da !== db) return da - db; // 目錄永遠在前
      let r = 0;
      if (sort.col === "size") r = a.size - b.size;
      else if (sort.col === "mtime") r = (a.mtime ?? 0) - (b.mtime ?? 0);
      if (r === 0) r = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      return r * sort.dir;
    };
    return [...filtered].sort(cmp);
  }, [entries, showHidden, sort, filter]);
  const order = useMemo(() => visible.map((x) => x.name), [visible]);
  // 批次操作只算畫面上看得到的：篩選 / 隱藏檔切換藏起來的不會被「刪除 3 項」順手刪掉（清掉篩選後選取還在）。
  const selectedEntries = useMemo(() => visible.filter((x) => sel.names.has(x.name)), [visible, sel]);
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null;

  useEffect(() => {
    if (!kbScrollRef.current || !sel.anchor) return;
    kbScrollRef.current = false;
    listRef.current?.querySelector<HTMLElement>(`tr[data-name="${CSS.escape(sel.anchor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const toggleSort = (col: SortCol) => setSort((s) => (s.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: 1 }));

  // ---- 動作 ----
  const nameList = (names: string[]) =>
    names.length <= 5 ? names.join(t("、")) : t("{list} 等 {n} 項", { list: names.slice(0, 5).join(t("、")), n: names.length });
  const batchName = (names: string[]) => (names.length === 1 ? names[0] : t("{name} 等 {n} 項", { name: names[0], n: names.length }));

  /**
   * 目的地已有同名項目時問一次，回要用的策略；null = 使用者取消。
   * 全部都撞名時「略過」等於什麼都不做，只給覆蓋 / 取消；部分撞名才給三選一。
   * `mergeInto`：單一資料夾撞名時的說法（合併進去，而不是覆蓋）。
   */
  const askConflict = async (clash: string[], total: number, mergeInto: "local" | "remote" | null): Promise<SftpOnConflict | null> => {
    if (!clash.length) return "fail";
    const title = t("已有同名項目");
    if (clash.length === total) {
      const name = clash[0];
      const msg = total > 1
        ? t("目的地已有這 {n} 個同名項目：{list}。要全部覆蓋嗎？資料夾會合併進去，同名檔案會被取代。", { n: total, list: nameList(clash) })
        : mergeInto === "local"
          ? t("本機資料夾裡已有「{name}」，要合併進去嗎？同名檔案會被取代。", { name })
          : mergeInto === "remote"
            ? t("遠端已有資料夾「{name}」，要合併進去嗎？同名檔案會被取代。", { name })
            : t("遠端已有「{name}」，要覆蓋嗎？", { name });
      const ok = await uiConfirm(msg, { title, danger: true, confirmText: total === 1 && mergeInto ? t("合併") : t("覆蓋") });
      return ok ? "overwrite" : null;
    }
    const c = await uiChoose(
      t("目的地已有 {n} 個同名項目：{list}。\n「覆蓋」會取代同名檔案、合併同名資料夾；「略過同名」只傳其餘 {rest} 項。", {
        n: clash.length, list: nameList(clash), rest: total - clash.length,
      }),
      { title, danger: true, confirmText: t("覆蓋"), altText: t("略過同名") },
    );
    return c === "confirm" ? "overwrite" : c === "alt" ? "skip" : null;
  };

  // 雙擊 / Enter：資料夾進入；1 MiB 以內的檔在 App 內開（Xftp 的「編輯」）；更大的才下載。
  const openEntry = (e: SftpEntry) => {
    if (isDirEntry(e)) navigate(e.path);
    else if (canOpenInEditor(e.size)) setEditing(e);
    else void downloadFile(e);
  };
  const newFile = async () => {
    if (!sftpId) return;
    const name = await uiPrompt(t("新檔案名稱"), { title: t("新增檔案"), placeholder: t("例如 notes.txt") });
    if (!name?.trim()) return;
    try {
      const st = await api.sshSftpWriteText(sftpId, joinRemote(path, name.trim()), "", true);
      refresh();
      setEditing(st);
    } catch (err) { toast.error(errMsg(err)); }
  };
  // 編輯器存檔 / 權限變更後：就地更新這一列（大小、時間、權限），不必整個目錄重列。
  const patchEntry = (st: SftpEntry) =>
    setEntries((es) => es.map((x) => (x.path === st.path ? { ...st, name: x.name } : x)));
  // 單一檔案：另存新檔對話框（可以改名；已有同名檔時系統對話框自己會問）。
  const downloadFile = async (e: SftpEntry) => {
    if (!sftpId) return;
    const local = await pickSaveFile(e.name);
    if (!local) return;
    try {
      const id = await api.sshSftpDownload(sftpId, e.path, local, true);
      useSshTransfers.getState().track({ id, name: e.name, kind: "download", tabKey });
    } catch (err) { toast.error(errMsg(err)); }
  };
  // 資料夾或多選：選一個本機資料夾，全部放進去（Xftp 多選拖到本機）。整批一個工作、依序傳。
  const downloadMany = async (targets: SftpEntry[]) => {
    if (!sftpId || !targets.length) return;
    const dir = await pickDirectory();
    if (!dir) return;
    try {
      const clash = await api.sshSftpLocalConflicts(dir, targets.map((x) => x.name));
      const onConflict = await askConflict(clash, targets.length, targets.length === 1 && isDirEntry(targets[0]) ? "local" : null);
      if (!onConflict) return;
      const id = await api.sshSftpDownloadMany(sftpId, targets.map((x) => x.path), dir, onConflict);
      useSshTransfers.getState().track({ id, name: batchName(targets.map((x) => x.name)), kind: "download", tabKey, batch: true });
    } catch (err) { toast.error(errMsg(err)); }
  };
  const download = (targets: SftpEntry[]) => {
    if (targets.length === 1 && !isDirEntry(targets[0])) void downloadFile(targets[0]);
    else void downloadMany(targets);
  };
  // 上傳（多個檔案，或一個資料夾）到目前資料夾。同名用目前的清單判斷；後端開始前會再確認一次。
  const uploadMany = async (locals: string[], isFolder: boolean) => {
    if (!sftpId || !locals.length) return;
    const names = locals.map(baseName);
    const existing = new Set(entries.map((x) => x.name));
    const clash = names.filter((n) => existing.has(n));
    const onConflict = await askConflict(clash, locals.length, isFolder && locals.length === 1 ? "remote" : null);
    if (!onConflict) return;
    try {
      const id = await api.sshSftpUploadMany(sftpId, locals, path, onConflict);
      useSshTransfers.getState().track({ id, name: batchName(names), kind: "upload", tabKey, batch: true, onDone: refreshIfStillIn(path) });
    } catch (err) { toast.error(errMsg(err)); }
  };
  const uploadFiles = async () => {
    if (!sftpId) return;
    await uploadMany(await pickOpenFiles(), false);
  };
  const uploadFolder = async () => {
    if (!sftpId) return;
    const dir = await pickDirectory();
    if (dir) await uploadMany([dir], true);
  };
  const mkdir = async () => {
    if (!sftpId) return;
    const name = await uiPrompt(t("新資料夾名稱"), { title: t("新資料夾"), placeholder: t("資料夾名稱") });
    if (!name?.trim()) return;
    try { await api.sshSftpMkdir(sftpId, joinRemote(path, name.trim())); refresh(); } catch (err) { toast.error(errMsg(err)); }
  };
  const rename = async (e: SftpEntry) => {
    if (!sftpId) return;
    const name = await uiPrompt(t("重新命名「{name}」", { name: e.name }), { title: t("重新命名"), defaultValue: e.name });
    if (!name?.trim() || name.trim() === e.name) return;
    try { await api.sshSftpRename(sftpId, e.path, joinRemote(parentOf(e.path), name.trim())); refresh(); } catch (err) { toast.error(errMsg(err)); }
  };
  const remove = async (e: SftpEntry) => {
    if (!sftpId) return;
    const ok = await uiConfirm(
      e.is_dir ? t("刪除資料夾「{name}」及其全部內容？此動作無法復原。", { name: e.name }) : t("刪除「{name}」？此動作無法復原。", { name: e.name }),
      { title: t("刪除"), danger: true, confirmText: t("刪除") },
    );
    if (!ok) return;
    try { await api.sshSftpRemove(sftpId, e.path, e.is_dir); refresh(); } catch (err) { toast.error(errMsg(err)); }
  };
  // 多選刪除：確認一次，依畫面順序逐一刪；有失敗也把其餘的刪完，最後一起回報。
  const removeMany = async (targets: SftpEntry[]) => {
    if (!sftpId || !targets.length) return;
    if (targets.length === 1) { await remove(targets[0]); return; }
    const dirs = targets.filter((x) => x.is_dir).length;
    const names = nameList(targets.map((x) => x.name));
    const ok = await uiConfirm(
      dirs
        ? t("刪除這 {n} 個項目（其中 {d} 個資料夾連同全部內容）？此動作無法復原。\n{list}", { n: targets.length, d: dirs, list: names })
        : t("刪除這 {n} 個項目？此動作無法復原。\n{list}", { n: targets.length, list: names }),
      { title: t("刪除"), danger: true, confirmText: t("刪除") },
    );
    if (!ok) return;
    const failed: string[] = [];
    let firstErr = "";
    for (const e of targets) {
      try { await api.sshSftpRemove(sftpId, e.path, e.is_dir); } catch (err) {
        failed.push(e.name);
        if (!firstErr) firstErr = errMsg(err);
      }
    }
    refresh();
    if (failed.length) toast.error(t("{n} 項刪除失敗（{name}）：{msg}", { n: failed.length, name: failed[0], msg: firstErr }));
    else toast.success(t("已刪除 {n} 項", { n: targets.length }));
  };
  const copyPaths = (targets: SftpEntry[]) =>
    void copyToClipboard(targets.map((x) => x.path).join("\n"), targets.length > 1 ? t("已複製 {n} 個路徑", { n: targets.length }) : undefined);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // 只接「焦點在面板本身 / 檔案清單」的按鍵。路徑、篩選框、權限對話框、編輯器（CodeMirror 是
    // contenteditable，而且對話框沒有走 portal、DOM 就在這個面板裡）的按鍵都會冒泡上來——
    // 不擋的話，在編輯器裡按 Backspace 會跳上一層、按 Delete 會跳出刪檔確認。
    const el = e.target as HTMLElement;
    if (el !== e.currentTarget && !el.closest?.("[data-sftp-list]")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      filterRef.current?.focus();
      filterRef.current?.select();
      return;
    }
    if (mod && !e.shiftKey && (e.key === "a" || e.key === "A")) { e.preventDefault(); setSel(selectAll(order)); return; }
    if (e.key === "Escape" && sel.names.size) { e.preventDefault(); setSel(EMPTY_SELECTION); return; }
    if (e.key === "Backspace") { e.preventDefault(); navigate(parentOf(path)); return; }
    if (e.key === "F5") { e.preventDefault(); refresh(); return; }
    if (e.key === "Enter" && single) { e.preventDefault(); openEntry(single); return; }
    if (e.key === "Delete" && selectedEntries.length) { e.preventDefault(); void removeMany(selectedEntries); return; }
    if (e.key === "F2" && single) { e.preventDefault(); void rename(single); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const extend = e.shiftKey;
      kbScrollRef.current = true;
      setSel((s) => moveSelect(s, delta, order, extend));
      return;
    }
    if ((e.key === "Home" || e.key === "End") && order.length) {
      e.preventDefault();
      const target = e.key === "Home" ? order[0] : order[order.length - 1];
      const shift = e.shiftKey;
      kbScrollRef.current = true;
      setSel((s) => clickSelect(s, target, { ctrl: false, shift }, order));
    }
  };

  const crumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    const acc: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let cur = "";
    for (const p of parts) { cur += `/${p}`; acc.push({ label: p, path: cur }); }
    return acc;
  }, [path]);

  const myJobs = Object.values(jobs).filter((j) => j.tabKey === tabKey);
  const sortMark = (col: SortCol) => (sort.col === col ? (sort.dir === 1 ? " ▲" : " ▼") : "");
  const selectedBytes = selectedEntries.reduce((a, x) => a + (x.is_dir ? 0 : x.size), 0);

  const menuItems = (): [string, () => void][] => {
    if (!menu) return [];
    const { entry, targets } = menu;
    if (entry && targets.length > 1) {
      const n = targets.length;
      return [
        [t("下載 {n} 項…", { n }), () => void downloadMany(targets)],
        [t("刪除 {n} 項…", { n }), () => void removeMany(targets)],
        [t("複製 {n} 個路徑", { n }), () => copyPaths(targets)],
      ];
    }
    if (entry) {
      const dir = isDirEntry(entry);
      return [
        ...(dir
          ? ([[t("開啟"), () => navigate(entry.path)], [t("下載資料夾…"), () => void downloadMany([entry])]] as [string, () => void][])
          : ([
              ...(canOpenInEditor(entry.size) ? [[t("編輯"), () => setEditing(entry)]] : []),
              [t("下載…"), () => void downloadFile(entry)],
            ] as [string, () => void][])),
        [t("重新命名…（F2）"), () => void rename(entry)],
        [t("權限…"), () => setPermsFor(entry)],
        [t("刪除"), () => void remove(entry)],
        [t("複製路徑"), () => copyPaths([entry])],
        [t("在終端機 cd 到此"), () => onCd(entry.is_dir ? entry.path : parentOf(entry.path))],
      ];
    }
    return [
      [t("上傳檔案…"), () => void uploadFiles()],
      [t("上傳資料夾…"), () => void uploadFolder()],
      [t("新增檔案…"), () => void newFile()],
      [t("新資料夾…"), () => void mkdir()],
      [t("全選（Ctrl+A）"), () => setSel(selectAll(order))],
      [t("重新整理"), refresh],
      [t("複製路徑"), () => void copyToClipboard(path)],
      [t("在終端機 cd 到此"), () => onCd(path)],
    ];
  };

  return (
    <div data-testid="sftp-panel" className="flex-1 flex flex-col min-h-0 min-w-0 text-xs" tabIndex={0} onKeyDown={onKeyDown}>
      {/* 標題列 */}
      <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-fg/10">
        <span className="font-medium text-fg/70">SFTP</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon={ArrowUp} label={t("上一層（Backspace）")} onClick={() => navigate(parentOf(path))} disabled={path === "/"} />
          <IconButton icon={RefreshCw} label={t("重新整理（F5）")} onClick={refresh} disabled={!sftpId} />
          <IconButton icon={showHidden ? Eye : EyeOff} label={showHidden ? t("隱藏隱藏檔") : t("顯示隱藏檔")} active={showHidden} onClick={() => setShowHidden((v) => !v)} />
          <IconButton icon={FilePlus} label={t("新增檔案")} onClick={() => void newFile()} disabled={!sftpId} />
          <IconButton icon={FolderPlus} label={t("新資料夾")} onClick={() => void mkdir()} disabled={!sftpId} />
          <IconButton icon={Download} label={t("下載選取的項目")} onClick={() => download(selectedEntries)} disabled={!sftpId || !selectedEntries.length} />
          <IconButton icon={Upload} label={t("上傳檔案")} onClick={() => void uploadFiles()} disabled={!sftpId} />
          <IconButton icon={FolderUp} label={t("上傳資料夾")} onClick={() => void uploadFolder()} disabled={!sftpId} />
          <IconButton icon={X} label={t("關閉 SFTP")} onClick={onClose} />
        </div>
      </div>
      {/* 麵包屑 / 路徑輸入 */}
      <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-fg/10 overflow-x-auto mono">
        {editingPath != null ? (
          <input
            ref={pathInputRef}
            autoFocus
            value={editingPath}
            onChange={(e) => setEditingPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); const p = editingPath.trim() || "/"; setEditingPath(null); navigate(p); }
              else if (e.key === "Escape") { e.preventDefault(); setEditingPath(null); }
            }}
            onBlur={() => setEditingPath(null)}
            className="flex-1 min-w-0 bg-inset border border-fg/10 rounded px-2 py-0.5 outline-none focus:border-accent/60"
          />
        ) : (
          <>
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center shrink-0">
                {i > 0 && <Icon icon={ChevronRight} size={11} className="text-fg/30" />}
                <button type="button" onClick={() => navigate(c.path)}
                  className={`px-1 rounded hover:bg-fg/10 ${i === crumbs.length - 1 ? "text-fg/90" : "text-fg/55"}`}>{c.label}</button>
              </span>
            ))}
            <IconButton icon={Pencil} label={t("輸入路徑")} box="w-5 h-5" iconSize={11} className="ml-auto" onClick={() => setEditingPath(path)} />
          </>
        )}
      </div>
      {/* 篩選：只過濾這一層的名稱（Ctrl+F 聚焦、Esc 清除） */}
      <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-fg/10">
        <Icon icon={ListFilter} size={12} className="text-fg/35 shrink-0" />
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setFilter(""); (e.currentTarget.closest("[data-testid=sftp-panel]") as HTMLElement | null)?.focus(); } }}
          placeholder={t("篩選名稱…（Ctrl+F）")}
          aria-label={t("篩選名稱")}
          className="flex-1 min-w-0 bg-transparent outline-none placeholder:text-fg/30"
        />
        {filter && <IconButton icon={X} label={t("清除篩選")} box="w-5 h-5" iconSize={11} onClick={() => setFilter("")} />}
      </div>
      {/* 清單 */}
      <div ref={listRef} data-sftp-list="" className="flex-1 min-h-0 overflow-auto"
        onClick={(e) => {
          // 點在空白處（不是任何一列、也不是欄位標題）→ 清除選取，與檔案總管一致。
          const el = e.target as HTMLElement;
          if (!el.closest("tr[data-name]") && !el.closest("thead")) setSel(EMPTY_SELECTION);
        }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, entry: null, targets: [] }); }}>
        <table className="w-full border-collapse select-none">
          <thead className="sticky top-0 bg-panel text-fg/45 text-[10px] uppercase tracking-wide">
            <tr>
              <th className="text-left font-normal px-2 py-1 cursor-pointer" onClick={() => toggleSort("name")}>{t("名稱")}{sortMark("name")}</th>
              <th className="text-right font-normal px-2 py-1 cursor-pointer w-20" onClick={() => toggleSort("size")}>{t("大小")}{sortMark("size")}</th>
              <th className="text-left font-normal px-2 py-1 cursor-pointer w-36" onClick={() => toggleSort("mtime")}>{t("修改時間")}{sortMark("mtime")}</th>
              <th className="text-left font-normal px-2 py-1 w-24 mono">{t("權限")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => {
              const dir = isDirEntry(e);
              const isSel = sel.names.has(e.name);
              return (
                <tr key={e.name} data-name={e.name} aria-selected={isSel}
                  onClick={(ev) => setSel((s) => clickSelect(s, e.name, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey }, order))}
                  onDoubleClick={() => openEntry(e)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const next = contextSelect(sel, e.name);
                    setSel(next);
                    setMenu({ x: ev.clientX, y: ev.clientY, entry: e, targets: visible.filter((x) => next.names.has(x.name)) });
                  }}
                  className={`cursor-default ${isSel ? "bg-accent/15" : "hover:bg-fg/5"}`}>
                  <td className="px-2 py-0.5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      <Icon icon={e.is_symlink ? Link2 : dir ? Folder : File} size={13}
                        className={dir ? "text-amber-300/80" : e.is_symlink ? "text-sky-300/70" : "text-fg/40"} />
                      <span className="truncate max-w-[18rem]" title={e.path}>{e.name}</span>
                    </span>
                  </td>
                  <td className="px-2 py-0.5 text-right text-fg/60 mono whitespace-nowrap">{dir ? "" : fmtBytes(e.size)}</td>
                  <td className="px-2 py-0.5 text-fg/50 whitespace-nowrap">{fmtMtime(e.mtime)}</td>
                  <td className="px-2 py-0.5 text-fg/40 mono whitespace-nowrap">{e.mode}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && <div className="flex items-center gap-2 p-3 text-fg/50"><Spinner size={12} />{t("載入中…")}</div>}
        {!loading && error && <div className="p-3 text-danger">{error}</div>}
        {!loading && !error && visible.length === 0 && (
          <div className="p-3 text-fg/40">{filter.trim() ? t("沒有符合「{q}」的項目", { q: filter.trim() }) : t("（空資料夾）")}</div>
        )}
      </div>
      {/* 狀態列：項目數 / 選取摘要（Xftp 底部的摘要） */}
      <div data-testid="sftp-status" className="shrink-0 flex items-center gap-2 px-2 py-0.5 border-t border-fg/10 text-[10px] text-fg/45">
        <span>{filter.trim() ? t("{shown} / {n} 項", { shown: visible.length, n: entries.length }) : t("{n} 項", { n: visible.length })}</span>
        {selectedEntries.length > 1 ? (
          <span className="truncate">
            {t("已選取 {n} 項", { n: selectedEntries.length })}{selectedBytes ? ` · ${fmtBytes(selectedBytes)}` : ""}
          </span>
        ) : single ? (
          <span className="truncate mono" title={single.path}>
            {single.name}{single.is_dir ? "" : ` · ${fmtBytes(single.size)}`}{single.permissions != null ? ` · ${toOctal(single.permissions)}` : ""}
          </span>
        ) : null}
      </div>
      {/* 傳輸進度 */}
      {myJobs.length > 0 && (
        <div className="shrink-0 border-t border-fg/10 max-h-32 overflow-auto">
          {myJobs.map((j) => {
            const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : null;
            return (
              <div key={j.id} className="px-2 py-1 flex items-center gap-2">
                <Icon icon={j.kind === "upload" ? Upload : Download} size={12} className="text-fg/50 shrink-0" />
                <span className="truncate flex-1" title={j.name}>{j.name}</span>
                <span className="text-fg/45 mono shrink-0">{fmtBytes(j.done)}{j.total != null ? ` / ${fmtBytes(j.total)}` : ""}</span>
                <div className="w-20 h-1.5 bg-fg/10 rounded overflow-hidden shrink-0">
                  <div className={`h-full ${j.state === "error" ? "bg-danger" : j.state === "done" ? "bg-success" : "bg-accent"} ${pct == null && j.state === "running" ? "animate-pulse" : ""}`}
                    style={{ width: `${pct ?? 100}%` }} />
                </div>
                {j.state === "running"
                  ? <IconButton icon={X} label={t("取消傳輸")} box="w-5 h-5" iconSize={11} onClick={() => void useSshTransfers.getState().cancel(j.id)} />
                  : <IconButton icon={X} label={t("關閉")} box="w-5 h-5" iconSize={11} onClick={() => useSshTransfers.getState().dismiss(j.id)} />}
              </div>
            );
          })}
        </div>
      )}
      {menu && (
        <MenuPanel x={menu.x} y={menu.y} minW={170} onClose={() => setMenu(null)}>
          {menuItems().map(([label, fn]) => (
            <button key={label} type="button"
              onClick={() => { setMenu(null); fn(); }}
              className="block w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80">
              {label}
            </button>
          ))}
        </MenuPanel>
      )}
      {sftpId && (editing || permsFor) && (
        <Suspense fallback={null}>
          {editing && (
            <SftpFileEditor sftpId={sftpId} entry={editing} onClose={() => setEditing(null)} onSaved={patchEntry} />
          )}
          {permsFor && (
            <SftpPermsDialog sftpId={sftpId} entry={permsFor} onClose={() => setPermsFor(null)} onChanged={patchEntry} />
          )}
        </Suspense>
      )}
    </div>
  );
}
