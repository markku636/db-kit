// 檔案傳輸雙窗格的左邊：本機的檔案（RustDesk 檔案傳輸，照官方用戶端的「本機 | 對方」兩欄）。
// 瀏覽本機資料夾、多選後按「上傳 →」交給右邊的檔案面板傳到對方目前的資料夾；右邊下載的東西也放進這裡目前的資料夾。
// Windows 的最上層是磁碟機清單（後端 `local_list_dir("")`）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, File, Folder, HardDrive, Home, RefreshCw, Upload } from "lucide-react";
import { api } from "./api";
import type { LocalEntry } from "./rdTypes";
import { useT } from "./i18n";
import { Button, Icon, IconButton, Spinner } from "./ui/index";
import { fmtBytes } from "./schemaCache";
import { EMPTY_SELECTION, clickSelect, pruneSelection, selectAll, type Selection } from "./sftpSelection";

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

function fmtMtime(sec: number | null): string {
  if (sec == null) return "";
  try { return new Date(sec * 1000).toLocaleString(undefined, { hour12: false }); } catch { return ""; }
}

export interface LocalFilesPaneProps {
  /** 目前所在的資料夾變了（右邊的下載放進這裡）。 */
  onDirChange: (dir: string | null) => void;
  /** 「上傳 →」：選取的本機路徑。 */
  onUpload: (paths: string[]) => void;
  /** 變了就重新列一次（右邊下載完成時加一）。 */
  refreshKey: number;
  /** 右邊還沒連上時不能上傳。 */
  canUpload: boolean;
}

export default function LocalFilesPane({ onDirChange, onUpload, refreshKey, canUpload }: LocalFilesPaneProps) {
  const t = useT();
  /** null = 還沒列過（家目錄）；"" = Windows 磁碟機清單。 */
  const [dir, setDir] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const list = useCallback(async (path: string | null) => {
    setLoading(true);
    try {
      const r = await api.localListDir(path);
      setDir(r.path);
      setParent(r.parent);
      setEntries(r.entries);
      setError(null);
      onDirChange(r.path || null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [onDirChange]);

  useEffect(() => { void list(dir); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const order = useMemo(() => entries.map((e) => e.name), [entries]);
  useEffect(() => { setSel((s) => pruneSelection(s, order)); }, [order]);

  const selected = entries.filter((e) => sel.names.has(e.name));
  const isDrives = dir === "";
  const open = (e: LocalEntry) => { if (e.is_dir) { setSel(EMPTY_SELECTION); void list(e.path); } };
  const upload = () => { if (selected.length && canUpload && !isDrives) onUpload(selected.map((e) => e.path)); };

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col text-xs" data-local-pane="" tabIndex={0}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSel(selectAll(order)); }
        else if (e.key === "Enter" && selected.length === 1) { e.preventDefault(); open(selected[0]); }
        else if (e.key === "Backspace" && parent != null) { e.preventDefault(); void list(parent); }
      }}>
      <div className="shrink-0 h-8 flex items-center gap-1 px-2 border-b border-fg/10 bg-panel">
        <Icon icon={HardDrive} size={13} className="text-fg/50 shrink-0" />
        <span className="text-fg/70 shrink-0">{t("本機")}</span>
        <span className="truncate mono text-fg/45 min-w-0" title={dir ?? ""} data-local-path={dir ?? ""}>{isDrives ? t("所有磁碟機") : dir}</span>
        <div className="ml-auto flex items-center gap-0.5 shrink-0">
          <IconButton icon={ArrowUp} label={t("上一層")} box="w-6 h-6" iconSize={13} disabled={parent == null} onClick={() => parent != null && void list(parent)} />
          <IconButton icon={Home} label={t("家目錄")} box="w-6 h-6" iconSize={13} onClick={() => void list(null)} />
          <IconButton icon={RefreshCw} label={t("重新整理")} box="w-6 h-6" iconSize={13} onClick={() => void list(dir)} />
          <Button variant="primary" size="sm" icon={Upload} disabled={!selected.length || !canUpload || isDrives} onClick={upload}
            data-local-upload="" title={t("上傳選取的項目到右邊對方目前的資料夾")}>
            {t("上傳 →")}
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto" onClick={(e) => {
        if (!(e.target as HTMLElement).closest("tr[data-name]") && !(e.target as HTMLElement).closest("thead")) setSel(EMPTY_SELECTION);
      }}>
        <table className="w-full table-fixed border-collapse select-none">
          <thead className="sticky top-0 bg-panel text-fg/45 text-[10px] uppercase tracking-wide">
            <tr>
              <th className="text-left font-normal px-2 py-1 whitespace-nowrap">{t("名稱")}</th>
              <th className="text-right font-normal px-2 py-1 whitespace-nowrap w-16">{t("大小")}</th>
              <th className="text-left font-normal px-2 py-1 whitespace-nowrap w-32">{t("修改時間")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const isSel = sel.names.has(e.name);
              return (
                <tr key={e.name} data-name={e.name} aria-selected={isSel}
                  onClick={(ev) => setSel((s) => clickSelect(s, e.name, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey }, order))}
                  onDoubleClick={() => open(e)}
                  className={`cursor-default ${isSel ? "bg-accent/15" : "hover:bg-fg/5"}`}>
                  <td className="px-2 py-0.5 whitespace-nowrap overflow-hidden">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Icon icon={isDrives ? HardDrive : e.is_dir ? Folder : File} size={13}
                        className={`shrink-0 ${e.is_dir ? "text-amber-300/80" : "text-fg/40"}`} />
                      <span className="truncate min-w-0" title={e.path}>{e.name}</span>
                    </span>
                  </td>
                  <td className="px-2 py-0.5 text-right text-fg/60 mono whitespace-nowrap overflow-hidden text-ellipsis">{e.is_dir ? "" : fmtBytes(e.size)}</td>
                  <td className="px-2 py-0.5 text-fg/50 whitespace-nowrap overflow-hidden text-ellipsis">{fmtMtime(e.mtime)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && <div className="flex items-center gap-2 p-3 text-fg/50"><Spinner size={12} />{t("載入中…")}</div>}
        {!loading && error && <div className="p-3 text-danger">{error}</div>}
        {!loading && !error && entries.length === 0 && <div className="p-3 text-fg/40">{t("（空資料夾）")}</div>}
      </div>
    </div>
  );
}
