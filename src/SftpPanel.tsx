// SFTP 檔案瀏覽：掛在 SSH 終端機分頁右側的分割面板（WinSCP 式並排，而非 Xshell 另開 Xftp 視窗）。
// 用同一條 SSH 連線開 sftp subsystem，不會再問一次密碼 / OTP；「在終端機 cd 到此」也因此指向同一個 shell。
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowUp, ChevronRight, Download, EyeOff, File, Folder, FolderPlus, Link2, Pencil, RefreshCw, Upload, X, Eye,
} from "lucide-react";
import { api } from "./api";
import type { SftpEntry } from "./sshTypes";
import { sftpLastPath, useSshTerminals } from "./sshTerminals";
import { ensureSftpProgressListener, useSshTransfers } from "./useSshTransfers";
import { useT } from "./i18n";
import { Icon, IconButton, MenuPanel, Spinner } from "./ui/index";
import { copyToClipboard, pickOpenFile, pickSaveFile, toast, uiConfirm, uiPrompt } from "./ui";
import { fmtBytes } from "./schemaCache";

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
  const [selected, setSelected] = useState<string | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SftpEntry | null } | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const openingRef = useRef<string | null>(null);
  // 已經列過的 sftpId：自己剛開好的那個不要被 effect 再列一次（那次會拿舊的 path 蓋掉家目錄）。
  const listedRef = useRef<string | null>(null);
  // 列目錄的序號：快速連點兩個資料夾時，較晚回來的舊請求不能蓋掉較新的結果。
  const seqRef = useRef(0);

  const list = useCallback(async (id: string, p: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const es = await api.sshSftpList(id, p);
      if (seq !== seqRef.current) return;
      setEntries(es);
      setPath(p);
      lastPathByTab.set(tabKey, p);
      setSelected(null);
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

  const visible = useMemo(() => {
    const filtered = showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));
    const isDir = (e: SftpEntry) => e.is_dir || e.link_target_is_dir === true;
    const cmp = (a: SftpEntry, b: SftpEntry) => {
      const da = isDir(a) ? 0 : 1;
      const db = isDir(b) ? 0 : 1;
      if (da !== db) return da - db; // 目錄永遠在前
      let r = 0;
      if (sort.col === "size") r = a.size - b.size;
      else if (sort.col === "mtime") r = (a.mtime ?? 0) - (b.mtime ?? 0);
      if (r === 0) r = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      return r * sort.dir;
    };
    return [...filtered].sort(cmp);
  }, [entries, showHidden, sort]);

  const toggleSort = (col: SortCol) => setSort((s) => (s.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: 1 }));

  // ---- 動作 ----
  const openEntry = (e: SftpEntry) => {
    if (e.is_dir || e.link_target_is_dir) navigate(e.path);
    else void download(e);
  };
  const download = async (e: SftpEntry) => {
    if (!sftpId) return;
    const local = await pickSaveFile(e.name);
    if (!local) return;
    try {
      const id = await api.sshSftpDownload(sftpId, e.path, local, true);
      useSshTransfers.getState().track({ id, name: e.name, kind: "download", tabKey });
    } catch (err) { toast.error(errMsg(err)); }
  };
  const upload = async () => {
    if (!sftpId) return;
    const local = await pickOpenFile();
    if (!local) return;
    const name = baseName(local);
    const remote = joinRemote(path, name);
    let overwrite = false;
    if (entries.some((x) => x.name === name)) {
      const ok = await uiConfirm(t("遠端已有「{name}」，要覆蓋嗎？", { name }), { title: t("覆蓋檔案"), danger: true, confirmText: t("覆蓋") });
      if (!ok) return;
      overwrite = true;
    }
    try {
      const id = await api.sshSftpUpload(sftpId, local, remote, overwrite);
      useSshTransfers.getState().track({ id, name, kind: "upload", tabKey, onDone: refresh });
    } catch (err) { toast.error(errMsg(err)); }
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

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Backspace" && !editingPath) { e.preventDefault(); navigate(parentOf(path)); return; }
    if (e.key === "F5") { e.preventDefault(); refresh(); return; }
    const cur = visible.find((x) => x.name === selected);
    if (e.key === "Enter" && cur) { e.preventDefault(); openEntry(cur); return; }
    if (e.key === "Delete" && cur) { e.preventDefault(); void remove(cur); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = visible.findIndex((x) => x.name === selected);
      const n = e.key === "ArrowDown" ? Math.min(visible.length - 1, i + 1) : Math.max(0, i - 1);
      if (visible[n]) setSelected(visible[n].name);
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

  return (
    <div data-testid="sftp-panel" className="flex-1 flex flex-col min-h-0 min-w-0 text-xs" tabIndex={0} onKeyDown={onKeyDown}>
      {/* 標題列 */}
      <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-fg/10">
        <span className="font-medium text-fg/70">SFTP</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton icon={ArrowUp} label={t("上一層（Backspace）")} onClick={() => navigate(parentOf(path))} disabled={path === "/"} />
          <IconButton icon={RefreshCw} label={t("重新整理（F5）")} onClick={refresh} disabled={!sftpId} />
          <IconButton icon={showHidden ? Eye : EyeOff} label={showHidden ? t("隱藏隱藏檔") : t("顯示隱藏檔")} active={showHidden} onClick={() => setShowHidden((v) => !v)} />
          <IconButton icon={FolderPlus} label={t("新資料夾")} onClick={() => void mkdir()} disabled={!sftpId} />
          <IconButton icon={Upload} label={t("上傳到此")} onClick={() => void upload()} disabled={!sftpId} />
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
      {/* 清單 */}
      <div className="flex-1 min-h-0 overflow-auto" onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, entry: null }); }}>
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-panel text-fg/45 text-[10px] uppercase tracking-wide">
            <tr>
              <th className="text-left font-normal px-2 py-1 cursor-pointer select-none" onClick={() => toggleSort("name")}>{t("名稱")}{sortMark("name")}</th>
              <th className="text-right font-normal px-2 py-1 cursor-pointer select-none w-20" onClick={() => toggleSort("size")}>{t("大小")}{sortMark("size")}</th>
              <th className="text-left font-normal px-2 py-1 cursor-pointer select-none w-36" onClick={() => toggleSort("mtime")}>{t("修改時間")}{sortMark("mtime")}</th>
              <th className="text-left font-normal px-2 py-1 w-24 mono">{t("權限")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => {
              const dir = e.is_dir || e.link_target_is_dir === true;
              const sel = selected === e.name;
              return (
                <tr key={e.name}
                  onClick={() => setSelected(e.name)}
                  onDoubleClick={() => openEntry(e)}
                  onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); setSelected(e.name); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }); }}
                  className={`cursor-default ${sel ? "bg-accent/15" : "hover:bg-fg/5"}`}>
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
        {!loading && !error && visible.length === 0 && <div className="p-3 text-fg/40">{t("（空資料夾）")}</div>}
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
          {(menu.entry
            ? ([
                ...(menu.entry.is_dir || menu.entry.link_target_is_dir
                  ? [[t("開啟"), () => navigate(menu.entry!.path)]]
                  : [[t("下載"), () => void download(menu.entry!)]]),
                [t("重新命名…"), () => void rename(menu.entry!)],
                [t("刪除"), () => void remove(menu.entry!)],
                [t("複製路徑"), () => void copyToClipboard(menu.entry!.path)],
                [t("在終端機 cd 到此"), () => onCd(menu.entry!.is_dir ? menu.entry!.path : parentOf(menu.entry!.path))],
              ] as [string, () => void][])
            : ([
                [t("上傳到此…"), () => void upload()],
                [t("新資料夾…"), () => void mkdir()],
                [t("重新整理"), refresh],
                [t("複製路徑"), () => void copyToClipboard(path)],
                [t("在終端機 cd 到此"), () => onCd(path)],
              ] as [string, () => void][])
          ).map(([label, fn]) => (
            <button key={label} type="button"
              onClick={() => { setMenu(null); fn(); }}
              className="block w-full text-left px-3 py-1.5 hover:bg-fg/10 text-fg/80">
              {label}
            </button>
          ))}
        </MenuPanel>
      )}
    </div>
  );
}
