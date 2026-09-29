// SFTP 檔案瀏覽：掛在 SSH 終端機分頁右側的分割面板，也是 SFTP 獨立視窗（SftpWindow）的內容。
// 用同一條 SSH 連線開 sftp subsystem，不會再問一次密碼 / OTP；「在終端機 cd 到此」也因此指向同一個 shell。
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AppWindow, ArrowUp, ChevronRight, Download, EyeOff, File, FilePlus, Folder, FolderPlus, FolderSync, FolderUp, Link2, ListFilter,
  Maximize2, Minimize2, Pencil, RefreshCw, RotateCw, SquareTerminal, Upload, X, Eye,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./api";
import type { SftpEntry, SftpOnConflict } from "./sshTypes";
import { sftpFollowedDir, sftpHome, sftpLastPath, useSshTerminals } from "./sshTerminals";
import { useStore } from "./store";
import { useSshSessions } from "./sshSessions";
import { useSshPrefs } from "./sshPrefs";
import { resolveSftpDir } from "./sshConnString";
import { absTerminalDir, terminalDir } from "./sshCwd";
import { ensureSftpProgressListener, useSshTransfers } from "./useSshTransfers";
import { useT } from "./i18n";
import { Icon, IconButton, MenuPanel, Spinner } from "./ui/index";
import { remPx, useElementWidth } from "./ui/useElementWidth";
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
  /** 放大成整個分頁（宿主暫時收起終端機）。 */
  maximized?: boolean;
  onToggleMaximize?: () => void;
  /** 側邊面板「移到獨立視窗」：帶著目前所在的資料夾。 */
  onPopOut?: (path: string) => void;
  /** 主機設定的 SFTP 起始資料夾。沒給就從主視窗的分頁 / 主機清單查（獨立視窗裡查不到，由宿主帶進來）。 */
  startDir?: string;
  /** 第一次開通道時從這個資料夾開始（優先於終端機所在的資料夾與起始資料夾）。 */
  initialDir?: string;
  /**
   * 收系統的檔案拖放（Tauri 的 drag-drop 事件，拿得到本機路徑）→ 上傳。只有 SFTP 獨立視窗開得了：
   * 主視窗為了分頁拖曳關掉了 WebView 的檔案拖放，拖進來只拿得到沒有路徑的 File。
   */
  nativeDrop?: boolean;
}

/** Tauri drag-drop 事件的 payload（只取用得到的欄位；position 是實體像素、相對於 WebView 左上角）。 */
type NativeDrop =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

type SortCol = "name" | "size" | "mtime";

/** 每個終端機分頁的 SFTP 目前路徑（面板卸載後仍記得；分頁關閉時由 teardownSshTab 清掉）。 */
const lastPathByTab = sftpLastPath;

/** 這個分頁連的主機設定的 SFTP 起始資料夾（options.ui.sftp_dir；資料庫連線的 tunnel 分頁沒有）。 */
function startDirOf(tabKey: string): string | undefined {
  const sid = useStore.getState().sshTabs.find((x) => x.key === tabKey)?.sessionId;
  return sid ? useSshSessions.getState().sessions.find((s) => s.id === sid)?.options.ui?.sftp_dir : undefined;
}

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

export default function SftpPanel({
  tabKey, connId, onCd, onClose, maximized = false, onToggleMaximize, onPopOut, startDir, initialDir, nativeDrop = false,
}: SftpPanelProps) {
  const t = useT();
  const sftpId = useSshTerminals((s) => s.rt[tabKey]?.sftpId ?? null);
  const status = useSshTerminals((s) => s.rt[tabKey]?.status);
  const patch = useSshTerminals((s) => s.patch);
  const jobs = useSshTransfers((s) => s.jobs);
  // 終端機現在所在的資料夾（OSC 7 或視窗標題）。標題裡的 `~` 要有家目錄才解得開：家目錄在開 sftp 通道時拿到。
  const termDirRaw = useSshTerminals((s) => terminalDir(s.rt[tabKey]));
  const [home, setHome] = useState<string | null>(() => sftpHome.get(tabKey) ?? null);
  const termDir = absTerminalDir(termDirRaw, home);
  const follow = useSshPrefs((s) => s.sftpFollowTerminal);
  const setSshPrefs = useSshPrefs((s) => s.set);
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
  // 剪下的項目（到別的資料夾貼上 = 移動）。`dir` = 剪下時所在的資料夾，回到那裡時把它們畫淡。
  const [clip, setClip] = useState<{ dir: string; items: SftpEntry[] } | null>(null);
  // 系統檔案拖進來時，放開會上傳到哪個遠端資料夾（游標停在資料夾那一列 = 那個資料夾，否則目前的資料夾）。
  const [dropDir, setDropDir] = useState<string | null>(null);
  // 側邊面板收不到拖放的路徑：拖著檔案經過時提示改用獨立視窗。
  const [dragHint, setDragHint] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 欄位跟著清單寬度收：名稱至少留 6rem；先收「權限」（5rem），再收「修改時間」（8rem），「大小」（4rem）一定在。
  // 用 rem 算，介面字級放大時會提早收，不會出現橫向捲軸。
  const listWidth = useElementWidth(listRef);
  const rem = remPx();
  const showMtime = listWidth === null || listWidth >= 18 * rem;
  const showMode = listWidth === null || listWidth >= 23 * rem;
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

  /** 列目錄；回傳是否列成功（被較新的請求蓋過也算成功——那次結果本來就不要了）。 */
  const list = useCallback(async (id: string, p: string): Promise<boolean> => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const es = await api.sshSftpList(id, p);
      if (seq !== seqRef.current) return true;
      setEntries(es);
      // 同一個資料夾重新整理（上傳完、刪除後）保留選取裡還在的項目；換資料夾才清空。
      setSel((cur) => (p === pathRef.current ? pruneSelection(cur, es.map((x) => x.name)) : EMPTY_SELECTION));
      pathRef.current = p;
      setPath(p);
      lastPathByTab.set(tabKey, p);
      return true;
    } catch (e) {
      if (seq === seqRef.current) setError(errMsg(e));
      return false;
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [tabKey]);

  /** 此刻終端機所在的資料夾（絕對路徑；effect 裡用，不等 re-render）。 */
  const termDirNow = (h = sftpHome.get(tabKey)) => absTerminalDir(terminalDir(useSshTerminals.getState().rt[tabKey]), h);

  // 開啟 sftp subsystem：connId 換了（重連）就重開。起點依序是：終端機所在的資料夾（已經 cd 離開家目錄的話）、
  // 主機設定的 SFTP 起始資料夾、家目錄。已有 sftpId（面板關掉又打開）：終端機這段時間換了資料夾就跳去那裡，
  // 否則回到上次在面板裡逛到的地方。
  useEffect(() => {
    void ensureSftpProgressListener();
    if (status !== "connected") return;
    if (sftpId) {
      if (listedRef.current !== sftpId) {
        listedRef.current = sftpId;
        const td = termDirNow();
        if (td && td !== sftpFollowedDir.get(tabKey)) {
          sftpFollowedDir.set(tabKey, td);
          const back = path;
          void list(sftpId, td).then((ok) => { if (!ok) void list(sftpId, back); });
        } else {
          void list(sftpId, path);
        }
      }
      return;
    }
    if (openingRef.current === connId) return;
    openingRef.current = connId;
    (async () => {
      try {
        const info = await api.sshSftpOpen(connId);
        const h = info.home || "/";
        sftpHome.set(tabKey, h);
        const td = termDirNow(h);
        // 跟隨終端機的 effect 看到「已經跟到這裡」就不會再列一次：要在 sftpId / home 生效前記好。
        if (td) sftpFollowedDir.set(tabKey, td);
        // 先標記再 patch：patch 會觸發這個 effect 重跑，那次要認得「這個 sftpId 已經在列了」。
        listedRef.current = info.sftp_id;
        setHome(h);
        patch(tabKey, { sftpId: info.sftp_id });
        const start = initialDir || (td && td !== h ? td : resolveSftpDir(startDir ?? startDirOf(tabKey), h));
        // 起始資料夾不存在 / 沒權限：退回家目錄，別讓面板一打開就是一片錯誤。
        if (!(await list(info.sftp_id, start)) && start !== h) await list(info.sftp_id, h);
      } catch (e) {
        setError(errMsg(e));
      } finally {
        openingRef.current = null;
      }
    })();
    // 只在連線 / sftp 狀態變動時跑；path 由 navigate 自己管。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, sftpId, status]);

  // 跟隨終端機：在終端機 cd，面板就換到那個資料夾（開關記在 SSH 偏好裡）。
  useEffect(() => {
    if (!follow || !sftpId || !termDir || listedRef.current !== sftpId) return;
    if (termDir === sftpFollowedDir.get(tabKey)) return;
    sftpFollowedDir.set(tabKey, termDir);
    void list(sftpId, termDir);
  }, [follow, sftpId, termDir, tabKey, list]);

  const navigate = (p: string) => { if (sftpId) void list(sftpId, p || "/"); };
  const goToTerminalDir = () => {
    if (!sftpId || !termDir) return;
    sftpFollowedDir.set(tabKey, termDir);
    void list(sftpId, termDir);
  };
  const toggleFollow = () => {
    const next = !follow;
    setSshPrefs({ sftpFollowTerminal: next });
    if (next) goToTerminalDir();
  };
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
   * 全部都撞名時「略過」等於什麼都不做，改給覆蓋 / 續傳（上次傳到一半、重新選同一批來傳）/ 取消；
   * 部分撞名給覆蓋 / 略過同名 / 取消。`mergeInto`：單一資料夾撞名時的說法（合併進去，而不是覆蓋）。
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
      const c = await uiChoose(`${msg}\n${t("「續傳」：已經傳完的檔案略過，傳到一半的從中斷的地方接著傳。")}`, {
        title, danger: true, confirmText: total === 1 && mergeInto ? t("合併") : t("覆蓋"), altText: t("續傳"),
      });
      return c === "confirm" ? "overwrite" : c === "alt" ? "resume" : null;
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
  // 單一檔案：另存新檔對話框（可以改名；已有同名檔時系統對話框自己會問）。上次存到同一處失敗留下的
  // `.part`，後端比對過是這個檔的前半段就會接著傳。
  const downloadFile = async (e: SftpEntry) => {
    if (!sftpId) return;
    const local = await pickSaveFile(e.name);
    if (!local) return;
    try {
      const id = await api.sshSftpDownload(sftpId, e.path, local, true);
      useSshTransfers.getState().track({
        id, name: e.name, kind: "download", tabKey,
        retry: (sid) => api.sshSftpDownload(sid, e.path, local, true, true),
      });
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
      const remotes = targets.map((x) => x.path);
      const id = await api.sshSftpDownloadMany(sftpId, remotes, dir, onConflict);
      useSshTransfers.getState().track({
        id, name: batchName(targets.map((x) => x.name)), kind: "download", tabKey, batch: true,
        retry: (sid) => api.sshSftpDownloadMany(sid, remotes, dir, "resume"),
      });
    } catch (err) { toast.error(errMsg(err)); }
  };
  const download = (targets: SftpEntry[]) => {
    if (targets.length === 1 && !isDirEntry(targets[0])) void downloadFile(targets[0]);
    else void downloadMany(targets);
  };
  // 上傳（多個檔案 / 資料夾，可混合）到 `dest`（預設目前資料夾）。同名用那個資料夾的清單判斷；後端開始前會再確認一次。
  // `isFolder`：從「上傳資料夾」來的；拖放進來的分不出檔案或資料夾，單一項目撞到遠端資料夾就當成合併資料夾。
  const uploadMany = async (locals: string[], isFolder: boolean, dest = path) => {
    if (!sftpId || !locals.length) return;
    const names = locals.map(baseName);
    let there = entries;
    if (dest !== path) {
      try { there = await api.sshSftpList(sftpId, dest); }
      catch (err) { toast.error(t("無法開啟目的資料夾 {dir}：{msg}", { dir: dest, msg: errMsg(err) })); return; }
    }
    const existing = new Map(there.map((x) => [x.name, x]));
    const clash = names.filter((n) => existing.has(n));
    const single = locals.length === 1;
    const folderClash = single && clash.length === 1 && isDirEntry(existing.get(clash[0])!);
    const onConflict = await askConflict(clash, locals.length, single && (isFolder || folderClash) ? "remote" : null);
    if (!onConflict) return;
    try {
      const id = await api.sshSftpUploadMany(sftpId, locals, dest, onConflict);
      useSshTransfers.getState().track({
        id, name: batchName(names), kind: "upload", tabKey, batch: true, onDone: refreshIfStillIn(dest),
        retry: (sid) => api.sshSftpUploadMany(sid, locals, dest, "resume"),
      });
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

  // ---- 拖放上傳（SFTP 獨立視窗：Tauri 的 drag-drop 事件帶本機路徑）----
  /** 游標底下（實體像素）那一列是資料夾就放進那個資料夾，否則放進目前的資料夾。 */
  const dropTargetAt = (pos: { x: number; y: number }): string => {
    const dpr = window.devicePixelRatio || 1;
    const row = document.elementFromPoint(pos.x / dpr, pos.y / dpr)?.closest?.("tr[data-name]");
    const name = row?.getAttribute("data-name");
    const hit = name != null ? visible.find((x) => x.name === name) : undefined;
    return hit && isDirEntry(hit) ? hit.path : path;
  };
  const onNativeDrop = (p: NativeDrop) => {
    if (p.type === "leave") { setDropDir(null); return; }
    const dir = dropTargetAt(p.position);
    if (p.type !== "drop") { setDropDir(dir); return; }
    setDropDir(null);
    if (!p.paths.length) return;
    if (!sftpId) { toast.error(t("SFTP 還沒連上，等連線好再拖進來")); return; }
    void uploadMany(p.paths, false, dir);
  };
  // 監聽只掛一次，事件進來時用最新的一版（目前資料夾、清單、sftpId 都會變）。
  const nativeDropRef = useRef(onNativeDrop);
  useEffect(() => { nativeDropRef.current = onNativeDrop; });
  useEffect(() => {
    if (!nativeDrop) return;
    let alive = true;
    let un: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((e) => nativeDropRef.current(e.payload as NativeDrop))
      .then((u) => { if (alive) un = u; else u(); })
      .catch(() => undefined);
    return () => { alive = false; un?.(); };
  }, [nativeDrop]);
  // 側邊面板：拖著檔案經過時提示改用獨立視窗（這裡的 drop 只拿得到沒有路徑的 File，傳不了）。
  const draggingFiles = (e: ReactDragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const htmlDragProps = nativeDrop || !onPopOut ? {} : {
    onDragOver: (e: ReactDragEvent) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      setDragHint(true);
    },
    onDragLeave: (e: ReactDragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragHint(false);
    },
    onDrop: (e: ReactDragEvent) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      setDragHint(false);
      toast.info(t("拖放上傳請在 SFTP 獨立視窗裡進行：按上方的「移到獨立視窗」，再把檔案拖進去"));
    },
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

  // ---- 移動（剪下 → 到別的資料夾貼上，或「移動到…」直接輸入目的資料夾）----
  // SFTP 沒有伺服器端的複製，貼上一律是搬過去（rename），同一台機器上大檔也是瞬間完成。
  const cut = (targets: SftpEntry[]) => { if (targets.length) setClip({ dir: path, items: targets }); };
  /** 搬進 `destDir`；回 false = 檢查沒過、什麼都沒動（剪下的內容留著讓使用者換個地方再貼）。 */
  const moveInto = async (destDir: string, items: SftpEntry[]): Promise<boolean> => {
    if (!sftpId || !items.length) return false;
    const dest = destDir.trim().replace(/(.)\/+$/, "$1") || "/";
    const inside = items.find((x) => dest === x.path || dest.startsWith(`${x.path}/`));
    if (inside) { toast.error(t("不能把「{name}」移到它自己裡面", { name: inside.name })); return false; }
    const moving = items.filter((x) => parentOf(x.path) !== dest);
    if (!moving.length) { toast.info(t("已經在這個資料夾了")); return false; }
    let there: SftpEntry[];
    try { there = dest === path ? entries : await api.sshSftpList(sftpId, dest); }
    catch (err) { toast.error(t("無法開啟目的資料夾 {dir}：{msg}", { dir: dest, msg: errMsg(err) })); return false; }
    const names = new Set(there.map((x) => x.name));
    const clash = moving.filter((x) => names.has(x.name)).map((x) => x.name);
    if (clash.length) { toast.error(t("目的資料夾已有同名項目：{list}。請先改名再移動。", { list: nameList(clash) })); return false; }
    const failed: string[] = [];
    let firstErr = "";
    for (const x of moving) {
      try { await api.sshSftpRename(sftpId, x.path, joinRemote(dest, x.name)); } catch (err) {
        failed.push(x.name);
        if (!firstErr) firstErr = errMsg(err);
      }
    }
    refresh();
    if (failed.length) toast.error(t("{n} 項移動失敗（{name}）：{msg}", { n: failed.length, name: failed[0], msg: firstErr }));
    else toast.success(t("已移動 {n} 項到 {dir}", { n: moving.length, dir: dest }));
    return true;
  };
  const pasteHere = async () => {
    if (clip && (await moveInto(path, clip.items))) setClip(null);
  };
  const moveToPrompt = async (targets: SftpEntry[]) => {
    const dest = await uiPrompt(
      targets.length > 1 ? t("把這 {n} 項移到哪個資料夾？", { n: targets.length }) : t("把「{name}」移到哪個資料夾？", { name: targets[0].name }),
      { title: t("移動到"), defaultValue: path, confirmText: t("移動") },
    );
    if (dest?.trim()) await moveInto(dest, targets);
  };

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
    if (mod && !e.shiftKey && (e.key === "x" || e.key === "X") && selectedEntries.length) { e.preventDefault(); cut(selectedEntries); return; }
    if (mod && !e.shiftKey && (e.key === "v" || e.key === "V") && clip) { e.preventDefault(); void pasteHere(); return; }
    if (e.key === "Escape" && sel.names.size) { e.preventDefault(); setSel(EMPTY_SELECTION); return; }
    if (e.key === "Escape" && clip) { e.preventDefault(); setClip(null); return; }
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
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path, editingPath]);

  const myJobs = Object.values(jobs).filter((j) => j.tabKey === tabKey);
  const cutHere = useMemo(() => new Set(clip && clip.dir === path ? clip.items.map((x) => x.name) : []), [clip, path]);
  const sortMark = (col: SortCol) => (sort.col === col ? (sort.dir === 1 ? " ▲" : " ▼") : "");
  const selectedBytes = selectedEntries.reduce((a, x) => a + (x.is_dir ? 0 : x.size), 0);

  const menuItems = (): [string, () => void][] => {
    if (!menu) return [];
    const { entry, targets } = menu;
    if (entry && targets.length > 1) {
      const n = targets.length;
      return [
        [t("下載 {n} 項…", { n }), () => void downloadMany(targets)],
        [t("剪下 {n} 項（Ctrl+X）", { n }), () => cut(targets)],
        [t("移動 {n} 項到…", { n }), () => void moveToPrompt(targets)],
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
        [t("剪下（Ctrl+X）"), () => cut([entry])],
        [t("移動到…"), () => void moveToPrompt([entry])],
        [t("權限…"), () => setPermsFor(entry)],
        [t("刪除"), () => void remove(entry)],
        [t("複製路徑"), () => copyPaths([entry])],
        [t("在終端機 cd 到此"), () => onCd(entry.is_dir ? entry.path : parentOf(entry.path))],
      ];
    }
    return [
      ...(clip ? ([[t("貼上：把剪下的 {n} 項移到這裡（Ctrl+V）", { n: clip.items.length }), () => void pasteHere()]] as [string, () => void][]) : []),
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
    <div data-testid="sftp-panel" className="flex-1 flex flex-col min-h-0 min-w-0 text-xs" tabIndex={0} onKeyDown={onKeyDown} {...htmlDragProps}>
      {/* 標題列：對檔案的動作 */}
      <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-fg/10">
        <span className="font-medium text-fg/70">SFTP</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon={FilePlus} label={t("新增檔案")} onClick={() => void newFile()} disabled={!sftpId} />
          <IconButton icon={FolderPlus} label={t("新資料夾")} onClick={() => void mkdir()} disabled={!sftpId} />
          <IconButton icon={Download} label={t("下載選取的項目")} onClick={() => download(selectedEntries)} disabled={!sftpId || !selectedEntries.length} />
          <IconButton icon={Upload} label={t("上傳檔案")} onClick={() => void uploadFiles()} disabled={!sftpId} />
          <IconButton icon={FolderUp} label={t("上傳資料夾")} onClick={() => void uploadFolder()} disabled={!sftpId} />
          {onPopOut && (
            <IconButton icon={AppWindow} label={t("移到獨立視窗（可拖放檔案上傳）")} onClick={() => onPopOut(path)} />
          )}
          {onToggleMaximize && (
            <IconButton icon={maximized ? Minimize2 : Maximize2} label={maximized ? t("還原 SFTP 面板大小") : t("放大 SFTP 面板")}
              active={maximized} onClick={onToggleMaximize} />
          )}
          <IconButton icon={X} label={t("關閉 SFTP")} onClick={onClose} />
        </div>
      </div>
      {/* 導覽：上一層 / 重新整理 / 麵包屑（可輸入路徑）/ 跳到終端機所在的資料夾 / 跟隨終端機 */}
      <div className="shrink-0 flex items-center gap-0.5 px-1 py-1 border-b border-fg/10">
        <IconButton icon={ArrowUp} label={t("上一層（Backspace）")} box="w-6 h-6" iconSize={14} onClick={() => navigate(parentOf(path))} disabled={path === "/"} />
        <IconButton icon={RefreshCw} label={t("重新整理（F5）")} box="w-6 h-6" iconSize={13} onClick={refresh} disabled={!sftpId} />
        {/* 路徑太長（或介面字級放大）時麵包屑橫向捲動，換資料夾時捲到最右邊：目前所在的那一層一定看得到。 */}
        <div ref={crumbsRef} data-hscroll-ok="" className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto mono">
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
            </>
          )}
        </div>
        {/* 放在可捲動的麵包屑外面，不會被擠出去裁掉。 */}
        {editingPath == null && (
          <IconButton icon={Pencil} label={t("輸入路徑")} box="w-5 h-5" iconSize={11} className="shrink-0" onClick={() => setEditingPath(path)} />
        )}
        <IconButton icon={SquareTerminal} box="w-6 h-6" iconSize={14} disabled={!sftpId || !termDir}
          label={termDir ? t("到終端機目前的資料夾：{dir}", { dir: termDir }) : t("看不出終端機目前在哪個資料夾（shell 沒有回報）")}
          onClick={goToTerminalDir} />
        <IconButton icon={FolderSync} box="w-6 h-6" iconSize={14} active={follow} aria-pressed={follow}
          label={follow ? t("跟隨終端機切換資料夾：開（再按一下關閉）") : t("跟隨終端機切換資料夾：在終端機 cd，這裡就跟著換")}
          onClick={toggleFollow} />
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
        <IconButton icon={showHidden ? Eye : EyeOff} label={showHidden ? t("隱藏隱藏檔") : t("顯示隱藏檔")} box="w-6 h-6" iconSize={13}
          active={showHidden} onClick={() => setShowHidden((v) => !v)} />
      </div>
      {/* 清單（拖放提示疊在上面，不跟著清單捲動） */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        {dropDir != null && (
          <div data-testid="sftp-drop-target" data-dir={dropDir}
            className={`absolute inset-0 z-10 pointer-events-none flex items-end justify-center p-3 rounded ${dropDir === path ? "border-2 border-dashed border-accent/70 bg-accent/5" : ""}`}>
            <span className="px-3 py-1.5 rounded bg-elevated border border-accent/40 shadow-lg text-fg/90 flex items-center gap-1.5 max-w-full">
              <Icon icon={Upload} size={13} className="text-accent shrink-0" />
              <span className="truncate mono" title={dropDir}>{t("放開以上傳到 {dir}", { dir: dropDir })}</span>
            </span>
          </div>
        )}
        {dragHint && (
          <div data-testid="sftp-drag-hint" className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center p-4 bg-app/75">
            <div className="max-w-xs text-center space-y-1.5 px-4 py-3 rounded bg-elevated border border-fg/15 shadow-lg">
              <Icon icon={AppWindow} size={20} className="mx-auto text-accent" />
              <div className="font-medium text-fg/90">{t("拖放上傳請用 SFTP 獨立視窗")}</div>
              <div className="text-fg/55">{t("按上方的「移到獨立視窗」，再把檔案拖進去")}</div>
            </div>
          </div>
        )}
        <div ref={listRef} data-sftp-list="" className="flex-1 min-h-0 overflow-auto"
          onClick={(e) => {
            // 點在空白處（不是任何一列、也不是欄位標題）→ 清除選取，與檔案總管一致。
            const el = e.target as HTMLElement;
            if (!el.closest("tr[data-name]") && !el.closest("thead")) setSel(EMPTY_SELECTION);
          }}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, entry: null, targets: [] }); }}>
          {/* table-fixed：固定欄寬照 <th> 的 w-*，名稱欄吃剩下的寬度、太長就省略號，整張表不會比面板寬。 */}
          <table className="w-full table-fixed border-collapse select-none">
            <thead className="sticky top-0 bg-panel text-fg/45 text-[10px] uppercase tracking-wide">
              <tr>
                <th className="text-left font-normal px-2 py-1 cursor-pointer whitespace-nowrap" onClick={() => toggleSort("name")}>{t("名稱")}{sortMark("name")}</th>
                <th className="text-right font-normal px-2 py-1 cursor-pointer whitespace-nowrap w-16" onClick={() => toggleSort("size")}>{t("大小")}{sortMark("size")}</th>
                {showMtime && <th className="text-left font-normal px-2 py-1 cursor-pointer whitespace-nowrap w-32" onClick={() => toggleSort("mtime")}>{t("修改時間")}{sortMark("mtime")}</th>}
                {showMode && <th className="text-left font-normal px-1 py-1 whitespace-nowrap w-20 mono">{t("權限")}</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => {
                const dir = isDirEntry(e);
                const isSel = sel.names.has(e.name);
                const isCut = cutHere.has(e.name);
                const isDrop = dropDir != null && dropDir === e.path && dropDir !== path;
                return (
                  <tr key={e.name} data-name={e.name} aria-selected={isSel} data-drop={isDrop || undefined}
                    onClick={(ev) => setSel((s) => clickSelect(s, e.name, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey }, order))}
                    onDoubleClick={() => openEntry(e)}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      const next = contextSelect(sel, e.name);
                      setSel(next);
                      setMenu({ x: ev.clientX, y: ev.clientY, entry: e, targets: visible.filter((x) => next.names.has(x.name)) });
                    }}
                    className={`cursor-default ${isDrop ? "bg-accent/25 outline outline-1 -outline-offset-1 outline-accent/70" : isSel ? "bg-accent/15" : "hover:bg-fg/5"} ${isCut ? "opacity-50" : ""}`}>
                    <td className="px-2 py-0.5 whitespace-nowrap overflow-hidden">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <Icon icon={e.is_symlink ? Link2 : dir ? Folder : File} size={13}
                          className={`shrink-0 ${dir ? "text-amber-300/80" : e.is_symlink ? "text-sky-300/70" : "text-fg/40"}`} />
                        <span className="truncate min-w-0" title={e.path}>{e.name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-0.5 text-right text-fg/60 mono whitespace-nowrap overflow-hidden text-ellipsis">{dir ? "" : fmtBytes(e.size)}</td>
                    {showMtime && <td className="px-2 py-0.5 text-fg/50 whitespace-nowrap overflow-hidden text-ellipsis">{fmtMtime(e.mtime)}</td>}
                    {showMode && <td className="px-1 py-0.5 text-fg/40 mono whitespace-nowrap overflow-hidden text-ellipsis">{e.mode}</td>}
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
        {nativeDrop && !clip && (
          <span className="ml-auto min-w-0 truncate hidden sm:inline text-fg/35" title={t("可把檔案或資料夾拖進來上傳，拖到資料夾上就放進那個資料夾")}>
            {t("可把檔案或資料夾拖進來上傳，拖到資料夾上就放進那個資料夾")}
          </span>
        )}
        {clip && (
          <span data-testid="sftp-clip" className="ml-auto shrink-0 flex items-center gap-1 text-accent/80">
            {t("已剪下 {n} 項 · 到目的資料夾貼上（Ctrl+V）", { n: clip.items.length })}
            <IconButton icon={X} label={t("取消剪下")} box="w-4 h-4" iconSize={10} onClick={() => setClip(null)} />
          </span>
        )}
      </div>
      {/* 傳輸進度 */}
      {myJobs.length > 0 && (
        <div className="shrink-0 border-t border-fg/10 max-h-32 overflow-auto">
          {myJobs.map((j) => {
            const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : null;
            return (
              <div key={j.id} data-testid="sftp-job" data-state={j.state} className="px-2 py-1 flex items-center gap-2"
                title={j.state === "error" && j.message ? j.message : undefined}>
                <Icon icon={j.kind === "upload" ? Upload : Download} size={12} className="text-fg/50 shrink-0" />
                <span className={`truncate flex-1 ${j.state === "error" ? "text-danger" : ""}`} title={j.name}>{j.name}</span>
                <span className="text-fg/45 mono shrink-0">{fmtBytes(j.done)}{j.total != null ? ` / ${fmtBytes(j.total)}` : ""}</span>
                <div className="w-20 h-1.5 bg-fg/10 rounded overflow-hidden shrink-0">
                  <div className={`h-full ${j.state === "error" ? "bg-danger" : j.state === "done" ? "bg-success" : "bg-accent"} ${pct == null && j.state === "running" ? "animate-pulse" : ""}`}
                    style={{ width: `${pct ?? 100}%` }} />
                </div>
                {j.state === "error" && j.retry && (
                  <IconButton icon={RotateCw} label={t("續傳（從中斷的地方接著傳）")} box="w-5 h-5" iconSize={11} disabled={!sftpId}
                    onClick={() => { if (sftpId) void useSshTransfers.getState().resume(j.id, sftpId); }} />
                )}
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
