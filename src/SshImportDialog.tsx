// 匯入 SSH 主機：從 OpenSSH 設定檔（~/.ssh/config，含 Include）或 .xsh 工作階段檔的資料夾讀出主機，
// 勾選後存成一般的 SSH 主機。只讀來源、不動來源檔；密碼不匯入（連線時再問或之後在主機設定填）。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileInput, FolderOpen, RefreshCw } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { Badge, Button, Field, Input, Modal, Segmented, Select, Spinner } from "./ui/index";
import { pickDirectory, pickOpenFile, toast } from "./ui";
import { useSshSessions } from "./sshSessions";
import { candidateToSession, existingIndexes, folderLabel } from "./sshHostImport";
import type { SshHostImportKind, SshImportScan } from "./sshTypes";

const NEW_FOLDER = "__new__";

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export default function SshImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return createPortal(<Inner open={open} onClose={onClose} />, document.body);
}

function Inner({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const folders = useSshSessions((s) => s.folders);
  const [kind, setKind] = useState<SshHostImportKind>("ssh_config");
  const [path, setPath] = useState("");
  const [scan, setScan] = useState<SshImportScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [existing, setExisting] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState<string>(NEW_FOLDER);
  const [keepFolders, setKeepFolders] = useState(true);
  const [importing, setImporting] = useState(false);

  const runScan = async (k: SshHostImportKind, p: string) => {
    setScanning(true);
    setError(null);
    try {
      const r = await api.sshImportScan(k, p.trim() || null);
      const ex = existingIndexes(r.hosts, useSshSessions.getState().sessions);
      setScan(r);
      setPath(r.path);
      setExisting(ex);
      setChecked(new Set(r.hosts.map((_, i) => i).filter((i) => !ex.has(i))));
    } catch (e) {
      setScan(null);
      setError(errMsg(e));
    } finally {
      setScanning(false);
    }
  };

  // 換來源：預填預設位置並直接讀一次（找不到預設位置就等使用者自己選）。
  useEffect(() => {
    let alive = true;
    setScan(null);
    setError(null);
    api.sshImportDefaultPath(kind)
      .then((p) => {
        if (!alive) return;
        setPath(p ?? "");
        if (p) void runScan(kind, p);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [kind]);

  const browse = async () => {
    const p = kind === "ssh_config" ? await pickOpenFile() : await pickDirectory();
    if (p) { setPath(p); void runScan(kind, p); }
  };

  const hosts = scan?.hosts ?? [];
  const allChecked = hosts.length > 0 && checked.size === hosts.length;
  const toggle = (i: number) => setChecked((cur) => {
    const n = new Set(cur);
    if (n.has(i)) n.delete(i); else n.add(i);
    return n;
  });
  const useSourceFolders = kind === "xsh" && keepFolders;

  const doImport = async () => {
    if (!scan || !checked.size || importing) return;
    setImporting(true);
    const store = useSshSessions.getState();
    const keys = await api.sshKeysList().catch(() => []);
    const folderIds = new Map<string, string>();
    const ensureFolder = async (label: string): Promise<string> => {
      const cached = folderIds.get(label);
      if (cached) return cached;
      const found = useSshSessions.getState().folders.find((f) => f.name === label);
      const id = found ? found.id : (await store.addFolder(label)).id;
      folderIds.set(label, id);
      return id;
    };
    const fallbackName = kind === "ssh_config" ? t("匯入：ssh config") : t("匯入：.xsh");
    let ok = 0;
    const failed: string[] = [];
    try {
      for (const i of [...checked].sort((a, b) => a - b)) {
        const c = scan.hosts[i];
        let folderId: string | null;
        const src = useSourceFolders ? folderLabel(c.folder) : null;
        if (src) folderId = await ensureFolder(src);
        else if (target === NEW_FOLDER) folderId = await ensureFolder(fallbackName);
        else folderId = target || null;
        try {
          await store.save(candidateToSession(c, crypto.randomUUID(), folderId, keys), null, null);
          ok++;
        } catch {
          failed.push(c.name);
        }
      }
      if (ok) toast.success(t("已匯入 {n} 台主機", { n: ok }));
      if (failed.length) toast.error(t("{n} 台匯入失敗：{names}", { n: failed.length, names: failed.slice(0, 5).join(t("、")) }));
      if (ok) onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t("匯入 SSH 主機")} icon={FileInput} size="lg" zClass="z-[105]"
      bodyClassName="p-4 space-y-3 overflow-auto"
      footer={
        <>
          <Button variant="secondary" className="mr-auto" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" icon={FileInput} disabled={!checked.size} loading={importing} onClick={() => void doImport()}>
            {t("匯入 {n} 台", { n: checked.size })}
          </Button>
        </>
      }>
      <div data-testid="ssh-import" className="space-y-3">
        <Segmented full ariaLabel={t("來源")} value={kind} onChange={setKind} options={[
          { value: "ssh_config", label: t("OpenSSH 設定檔（~/.ssh/config）") },
          { value: "xsh", label: t(".xsh 工作階段檔") },
        ]} />
        <Field label={kind === "ssh_config" ? t("設定檔") : t("工作階段資料夾")}
          hint={kind === "ssh_config" ? t("含 Include 引入的檔案；萬用字元的 Host 與 Match 區塊不會變成主機") : t("連同子資料夾一起讀；子資料夾會變成主機資料夾")}>
          <div className="flex gap-2">
            <Input value={path} onChange={(e) => setPath(e.target.value)} aria-label={t("來源路徑")}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void runScan(kind, path); } }} />
            <Button variant="secondary" icon={FolderOpen} className="shrink-0" onClick={() => void browse()}>{t("瀏覽")}</Button>
            <Button variant="secondary" icon={RefreshCw} className="shrink-0" loading={scanning} onClick={() => void runScan(kind, path)}>{t("讀取")}</Button>
          </div>
        </Field>
        {error && <div className="rounded border border-danger/30 bg-danger/10 text-danger text-sm px-3 py-2 break-words">{error}</div>}
        {scanning && !scan && <div className="flex items-center gap-2 text-sm text-fg/50"><Spinner size={12} />{t("讀取中…")}</div>}
        {scan && (
          <>
            <div className="flex items-center gap-2 text-xs text-fg/55">
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" checked={allChecked} disabled={!hosts.length}
                  onChange={(e) => setChecked(e.target.checked ? new Set(hosts.map((_, i) => i)) : new Set())} />
                {t("全選")}
              </label>
              <span>
                {t("找到 {n} 台主機", { n: hosts.length })}
                {scan.skipped ? ` · ${t("略過 {n} 個萬用字元或非 SSH 的項目", { n: scan.skipped })}` : ""}
                {existing.size ? ` · ${t("{n} 台已經在清單裡（預設不勾）", { n: existing.size })}` : ""}
              </span>
            </div>
            {hosts.length === 0 ? (
              <div className="text-sm text-fg/45">{t("這裡沒有可以匯入的主機。")}</div>
            ) : (
              <div className="border border-fg/10 rounded divide-y divide-fg/10 max-h-[45vh] overflow-auto">
                {hosts.map((c, i) => (
                  <label key={i} data-import-index={i} className="flex items-start gap-2 px-3 py-1.5 cursor-pointer hover:bg-fg/5">
                    <input type="checkbox" className="mt-1" checked={checked.has(i)} onChange={() => toggle(i)} aria-label={c.name} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium truncate">{c.name}</span>
                        {c.folder && <span className="text-xs text-fg/40 truncate">{folderLabel(c.folder)}</span>}
                        {existing.has(i) && <Badge tone="neutral">{t("已存在")}</Badge>}
                      </div>
                      <div className="text-xs text-fg/55 mono truncate">
                        {c.username || "?"}@{c.host}{c.port !== 22 ? `:${c.port}` : ""}
                        {c.identity_file ? ` · ${t("私鑰 {name}", { name: baseName(c.identity_file) })}` : ""}
                        {c.certificate_file ? ` · ${t("憑證")}` : ""}
                        {c.xshell_key ? ` · ${t("金鑰 {name}", { name: c.xshell_key })}` : ""}
                      </div>
                      {c.notes.map((n) => <div key={n} className="text-xs text-warning">{n}</div>)}
                    </div>
                  </label>
                ))}
              </div>
            )}
            <div className="flex items-center gap-3 flex-wrap">
              {kind === "xsh" && (
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input type="checkbox" checked={keepFolders} onChange={(e) => setKeepFolders(e.target.checked)} />
                  {t("照原本的子資料夾分資料夾")}
                </label>
              )}
              <Field label={useSourceFolders ? t("沒有子資料夾的放到") : t("放到資料夾")} className="min-w-[14rem]">
                <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value={NEW_FOLDER}>{kind === "ssh_config" ? t("新資料夾「匯入：ssh config」") : t("新資料夾「匯入：.xsh」")}</option>
                  <option value="">{t("未分類")}</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
              </Field>
            </div>
            <div className="text-xs text-fg/45">
              {t("密碼不會匯入：密碼認證的主機會在第一次連線時詢問。沒有私鑰檔的先設成密碼認證，之後可在主機設定改用金鑰庫的金鑰。")}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
