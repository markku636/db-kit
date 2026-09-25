// SSH 使用者金鑰管理（Xshell 的「使用者金鑰管理員」）：金鑰庫清單、匯入（檔案 / 貼上，任何支援的格式，
// 一律轉存成 OpenSSH；原本有密語就用同一個密語重新加密）、產生新金鑰、複製公鑰、掛上 OpenSSH 憑證、匯出。
// 主機設定以 `keystore:<id>` 參照這裡的金鑰（onPick = 選擇模式）。
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BadgeCheck, ClipboardPaste, Copy, Download, FileKey, KeyRound, Lock, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { Badge, Button, EmptyState, Field, Icon, IconButton, Input, Modal, Segmented, Spinner, Textarea } from "./ui/index";
import { copyToClipboard, pickOpenFile, pickOpenFiles, pickSaveFile, toast, uiConfirm, uiPrompt } from "./ui";
import { useSshSessions } from "./sshSessions";
import { defaultKeyName, keyTypeLabel, sessionsUsingKey, shortFingerprint, sortStoredKeys } from "./sshKeys";
import { CertLine } from "./SshKeyStatus";
import type { SshKeyGenAlgorithm, SshKeyInspect, SshKeySource, SshStoredKey } from "./sshTypes";

export interface SshKeyManagerProps {
  open: boolean;
  onClose: () => void;
  /** 選擇模式：每列多一顆「使用」，選了就回呼（主機設定的「金鑰庫…」）。 */
  onPick?: (key: SshStoredKey) => void;
  /** 目前主機用的那把（選擇模式時高亮）。 */
  selectedId?: string | null;
}

type View = "list" | "import" | "paste" | "generate";

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
function sourceLabel(s: SshKeySource): string | null {
  return s.kind === "path" ? s.path : null;
}
function fileSlug(name: string): string {
  const s = name.trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return s ? `id_${s}` : "id_key";
}

export default function SshKeyManager(props: SshKeyManagerProps) {
  // 巢狀在其他對話框裡時，對話框外殼的進場動畫留著 transform，fixed 子元素會被困在外殼裡：一律 portal 到 body。
  return createPortal(<SshKeyManagerInner {...props} />, document.body);
}

function SshKeyManagerInner({ open, onClose, onPick, selectedId }: SshKeyManagerProps) {
  const t = useT();
  const [keys, setKeys] = useState<SshStoredKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("list");
  // 匯入（可一次選多個檔，逐一處理）
  const [queue, setQueue] = useState<SshKeySource[]>([]);
  const [source, setSource] = useState<SshKeySource | null>(null);
  const [inspect, setInspect] = useState<SshKeyInspect | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [name, setName] = useState("");
  const [protect, setProtect] = useState(false);
  const [newPass, setNewPass] = useState("");
  const [newPass2, setNewPass2] = useState("");
  const [busy, setBusy] = useState(false);
  // 貼上
  const [pasteText, setPasteText] = useState("");
  // 產生
  const [alg, setAlg] = useState<SshKeyGenAlgorithm>("ed25519");
  const [genName, setGenName] = useState("");
  const [genComment, setGenComment] = useState("");
  const [genPass, setGenPass] = useState("");
  const [genPass2, setGenPass2] = useState("");
  const [genResult, setGenResult] = useState<{ key: SshStoredKey; publicKey: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      setKeys(sortStoredKeys(await api.sshKeysList()));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  // ---- 匯入 ----
  const runInspect = async (src: SshKeySource, pass: string) => {
    setInspecting(true);
    try {
      const r = await api.sshKeyInspect(src, pass || null, null);
      setInspect(r);
      if (r.status === "ok" && r.info) setName((cur) => cur || defaultKeyName(r.info!.comment, sourceLabel(src)));
    } catch (e) {
      setInspect({ status: "invalid", format: null, info: null, message: errMsg(e), cert: null });
    } finally {
      setInspecting(false);
    }
  };
  const beginImport = (sources: SshKeySource[]) => {
    const [first, ...rest] = sources;
    if (!first) return;
    setQueue(rest);
    setSource(first);
    setInspect(null);
    setPassphrase("");
    setName("");
    setProtect(false);
    setNewPass("");
    setNewPass2("");
    setView("import");
    void runInspect(first, "");
  };
  const nextOrList = () => {
    if (queue.length) beginImport(queue);
    else { setSource(null); setView("list"); }
  };
  const importFiles = async () => {
    const paths = await pickOpenFiles();
    if (paths.length) beginImport(paths.map((path) => ({ kind: "path" as const, path })));
  };
  const protectMismatch = protect && newPass !== newPass2;
  const canImport = inspect?.status === "ok" && !busy && !(protect && (!newPass || protectMismatch));
  const doImport = async () => {
    if (!source || !canImport) return;
    setBusy(true);
    try {
      const out = await api.sshKeyImport(source, passphrase || null, protect ? newPass : null, name.trim() || null);
      if (out.existed) toast.info(t("金鑰庫已有這把金鑰：{name}", { name: out.key.name }));
      else toast.success(t("已匯入「{name}」", { name: out.key.name }));
      await reload();
      if (onPick && !queue.length) { onPick(out.key); return; }
      nextOrList();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- 產生 ----
  const genMismatch = genPass !== genPass2;
  const doGenerate = async () => {
    if (busy || genMismatch) return;
    setBusy(true);
    try {
      const key = await api.sshKeyGenerate(alg, genComment.trim(), genPass || null, genName.trim() || null);
      const publicKey = await api.sshKeyPublic(key.id);
      setGenResult({ key, publicKey });
      await reload();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const openGenerate = () => {
    setGenName(""); setGenComment(""); setGenPass(""); setGenPass2(""); setGenResult(null); setAlg("ed25519");
    setView("generate");
  };

  // ---- 列上的動作 ----
  const copyPublic = async (k: SshStoredKey) => {
    try { await copyToClipboard(await api.sshKeyPublic(k.id), t("已複製公鑰")); } catch (e) { toast.error(errMsg(e)); }
  };
  const attachCert = async (k: SshStoredKey) => {
    const path = await pickOpenFile();
    if (!path) return;
    try {
      const c = await api.sshKeyAttachCert(k.id, { kind: "path", path });
      toast.success(t("已掛上憑證（主體：{who}）", { who: c.principals.join(", ") || t("（不限主體）") }));
      await reload();
    } catch (e) { toast.error(errMsg(e)); }
  };
  const exportKey = async (k: SshStoredKey) => {
    const dest = await pickSaveFile(fileSlug(k.name));
    if (!dest) return;
    try {
      await api.sshKeyExport(k.id, dest);
      toast.success(t("已匯出到 {path}", { path: dest }));
    } catch (e) { toast.error(errMsg(e)); }
  };
  const renameKey = async (k: SshStoredKey) => {
    const n = await uiPrompt(t("金鑰名稱"), { title: t("重新命名"), defaultValue: k.name });
    if (!n?.trim() || n.trim() === k.name) return;
    try { await api.sshKeyRename(k.id, n.trim()); await reload(); } catch (e) { toast.error(errMsg(e)); }
  };
  const removeKey = async (k: SshStoredKey) => {
    const users = sessionsUsingKey(useSshSessions.getState().sessions, k.id);
    const ok = await uiConfirm(
      users.length
        ? t("刪除金鑰「{name}」？有 {n} 台主機正在用它（{list}），刪除後它們無法再用金鑰登入。此動作無法復原。", {
            name: k.name, n: users.length, list: users.map((s) => s.name || `${s.username}@${s.host}`).join(t("、")),
          })
        : t("刪除金鑰「{name}」？此動作無法復原；需要的話先「匯出」備份。", { name: k.name }),
      { title: t("刪除金鑰"), danger: true, confirmText: t("刪除") },
    );
    if (!ok) return;
    try { await api.sshKeyRemove(k.id); await reload(); } catch (e) { toast.error(errMsg(e)); }
  };

  // ---- 畫面 ----
  const info = inspect?.info ?? null;
  const footer = (() => {
    if (view === "import") {
      return (
        <>
          <Button variant="secondary" className="mr-auto" onClick={() => { setQueue([]); setSource(null); setView("list"); }}>{t("返回")}</Button>
          {queue.length > 0 && <Button variant="secondary" onClick={nextOrList}>{t("略過這把")}</Button>}
          <Button variant="primary" icon={Upload} onClick={() => void doImport()} disabled={!canImport} loading={busy}>
            {onPick && !queue.length ? t("匯入並使用") : t("匯入")}
          </Button>
        </>
      );
    }
    if (view === "paste") {
      return (
        <>
          <Button variant="secondary" className="mr-auto" onClick={() => setView("list")}>{t("返回")}</Button>
          <Button variant="primary" disabled={!pasteText.trim()} onClick={() => beginImport([{ kind: "text", text: pasteText }])}>{t("下一步")}</Button>
        </>
      );
    }
    if (view === "generate") {
      return genResult ? (
        <>
          <Button variant="secondary" className="mr-auto" onClick={() => setView("list")}>{t("完成")}</Button>
          {onPick && <Button variant="primary" onClick={() => onPick(genResult.key)}>{t("使用這把")}</Button>}
        </>
      ) : (
        <>
          <Button variant="secondary" className="mr-auto" onClick={() => setView("list")}>{t("返回")}</Button>
          <Button variant="primary" icon={Plus} onClick={() => void doGenerate()} disabled={genMismatch} loading={busy}>{t("產生")}</Button>
        </>
      );
    }
    return <Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>;
  })();

  return (
    <Modal open={open} onClose={onClose} title={onPick ? t("選擇 SSH 金鑰") : t("SSH 金鑰")} icon={KeyRound} size="lg" zClass="z-[105]"
      bodyClassName="p-4 space-y-3 overflow-auto" footer={footer}>
      <div data-testid="ssh-key-manager" className="space-y-3">
        {view === "list" && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="secondary" icon={FileKey} onClick={() => void importFiles()}>{t("匯入檔案…")}</Button>
              <Button variant="secondary" icon={ClipboardPaste} onClick={() => { setPasteText(""); setView("paste"); }}>{t("貼上金鑰…")}</Button>
              <Button variant="secondary" icon={Plus} onClick={openGenerate}>{t("產生新金鑰…")}</Button>
            </div>
            <div className="text-xs text-fg/45">
              {t("可匯入 OpenSSH、PuTTY（.ppk v2 / v3）、PKCS#8、PEM（PKCS#1 RSA / SEC1 EC，含 OpenSSL 的 3DES / AES 加密）與 DER；一律轉存成 OpenSSH 格式，原本有密語就維持同一個密語。私鑰旁邊的 <私鑰>-cert.pub 會一起帶進來。")}
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-fg/50 text-sm"><Spinner size={12} />{t("載入中…")}</div>
            ) : keys.length === 0 ? (
              <EmptyState compact icon={KeyRound} title={t("金鑰庫是空的")} hint={t("匯入既有的私鑰，或產生一把新的。")} />
            ) : (
              <div className="border border-fg/10 rounded divide-y divide-fg/10">
                {keys.map((k) => (
                  <div key={k.id} data-key-id={k.id}
                    className={`flex items-center gap-2 px-3 py-2 ${selectedId === k.id ? "bg-accent/10" : ""}`}>
                    <Icon icon={k.encrypted ? Lock : KeyRound} size={14} className={k.encrypted ? "text-warning shrink-0" : "text-fg/45 shrink-0"} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium truncate">{k.name}</span>
                        <span className="text-xs text-fg/50 shrink-0">{keyTypeLabel(k.algorithm, k.bits)}</span>
                        {k.encrypted && <Badge tone="warning">{t("密語")}</Badge>}
                        {k.has_cert && <Badge tone="info"><Icon icon={BadgeCheck} size={10} />{t("憑證")}</Badge>}
                      </div>
                      <div className="text-xs text-fg/40 mono truncate" title={k.fingerprint}>
                        {shortFingerprint(k.fingerprint, 24)}{k.comment && k.comment !== k.name ? ` · ${k.comment}` : ""}
                        {k.source_format ? ` · ${t("來源：{fmt}", { fmt: k.source_format })}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <IconButton icon={Copy} label={t("複製公鑰")} onClick={() => void copyPublic(k)} />
                      <IconButton icon={BadgeCheck} label={t("掛上 OpenSSH 憑證…")} onClick={() => void attachCert(k)} />
                      <IconButton icon={Download} label={t("匯出私鑰（OpenSSH）…")} onClick={() => void exportKey(k)} />
                      <IconButton icon={Pencil} label={t("重新命名…")} onClick={() => void renameKey(k)} />
                      <IconButton icon={Trash2} label={t("刪除")} onClick={() => void removeKey(k)} />
                      {onPick && <Button size="sm" variant={selectedId === k.id ? "secondary" : "primary"} onClick={() => onPick(k)}>{t("使用")}</Button>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {view === "paste" && (
          <Field label={t("貼上私鑰內容")} hint={t("例如從密碼管理器複製出來的 -----BEGIN OPENSSH PRIVATE KEY----- 或 PuTTY-User-Key-File-3 整段文字")}>
            <Textarea autoFocus rows={10} className="mono text-xs" value={pasteText} onChange={(e) => setPasteText(e.target.value)}
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----"} aria-label={t("貼上私鑰內容")} />
          </Field>
        )}

        {view === "import" && source && (
          <div data-testid="ssh-key-import" className="space-y-3">
            <div className="text-xs text-fg/50">
              {source.kind === "path" ? <span className="mono break-all">{source.path}</span> : t("貼上的內容")}
              {queue.length > 0 && <span className="ml-2">{t("（之後還有 {n} 個）", { n: queue.length })}</span>}
            </div>
            {inspecting && !inspect && <div className="flex items-center gap-2 text-sm text-fg/50"><Spinner size={12} />{t("檢查中…")}</div>}
            {inspect && (
              <>
                {info && (
                  <div className="rounded border border-fg/10 bg-inset px-3 py-2 text-sm space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{keyTypeLabel(info.algorithm, info.bits)}</span>
                      <span className="text-xs text-fg/50">{info.format}</span>
                      {info.encrypted && <Badge tone="warning">{t("受密語保護")}</Badge>}
                    </div>
                    <div className="mono text-xs text-fg/60 break-all select-all">{info.fingerprint}</div>
                    {info.comment && <div className="text-xs text-fg/45">{info.comment}</div>}
                  </div>
                )}
                {inspect.cert && <div className="text-xs"><CertLine cert={inspect.cert} /></div>}
                {(inspect.status === "need_passphrase" || inspect.status === "bad_passphrase") && (
                  <Field label={t("私鑰密語")} hint={inspect.status === "bad_passphrase" ? undefined : t("解開後才能確認內容與轉存；密語不會被儲存")}>
                    <div className="flex gap-2">
                      <Input type="password" autoFocus value={passphrase} aria-label={t("私鑰密語")}
                        onChange={(e) => setPassphrase(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && passphrase) { e.preventDefault(); void runInspect(source, passphrase); } }} />
                      <Button variant="secondary" icon={Lock} disabled={!passphrase} loading={inspecting} onClick={() => void runInspect(source, passphrase)}>{t("解開")}</Button>
                    </div>
                    {inspect.status === "bad_passphrase" && <div className="text-xs text-danger mt-1">{inspect.message}</div>}
                  </Field>
                )}
                {(inspect.status === "unsupported" || inspect.status === "invalid") && (
                  <div className="rounded border border-danger/30 bg-danger/10 text-danger text-sm px-3 py-2 whitespace-pre-wrap break-words">
                    {inspect.message}
                  </div>
                )}
                {inspect.status === "ok" && (
                  <>
                    <Field label={t("名稱")}>
                      <Input value={name} aria-label={t("名稱")} onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && canImport) { e.preventDefault(); void doImport(); } }} />
                    </Field>
                    {info?.encrypted ? (
                      <div className="text-xs text-fg/50">{t("轉存成 OpenSSH 格式後仍受同一個密語保護。")}</div>
                    ) : (
                      <>
                        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                          <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
                          <span>{t("匯入時加上密語保護")}</span>
                          <span className="text-xs text-fg/40">{t("這把私鑰目前沒有密語")}</span>
                        </label>
                        {protect && (
                          <div className="flex gap-3">
                            <Field label={t("新密語")} className="flex-1">
                              <Input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
                            </Field>
                            <Field label={t("再輸入一次")} className="flex-1">
                              <Input type="password" value={newPass2} onChange={(e) => setNewPass2(e.target.value)} />
                            </Field>
                          </div>
                        )}
                        {protectMismatch && newPass2 && <div className="text-xs text-danger">{t("兩次輸入的密語不一樣")}</div>}
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {view === "generate" && (
          genResult ? (
            <div data-testid="ssh-key-generated" className="space-y-3">
              <div className="text-sm">
                {t("已產生「{name}」", { name: genResult.key.name })} · {keyTypeLabel(genResult.key.algorithm, genResult.key.bits)}
                <div className="mono text-xs text-fg/50 break-all">{genResult.key.fingerprint}</div>
              </div>
              <Field label={t("公鑰")} hint={t("把這一行加進伺服器的 ~/.ssh/authorized_keys，就能用這把金鑰登入。")}>
                <Textarea data-testid="ssh-key-public" readOnly rows={3} className="mono text-xs" value={genResult.publicKey}
                  onFocus={(e) => e.currentTarget.select()} />
              </Field>
              <Button variant="secondary" icon={Copy} onClick={() => void copyToClipboard(genResult.publicKey, t("已複製公鑰"))}>{t("複製公鑰")}</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label={t("演算法")}>
                <Segmented full ariaLabel={t("演算法")} value={alg} onChange={setAlg} options={[
                  { value: "ed25519", label: t("Ed25519（建議）") },
                  { value: "ecdsa-p256", label: "ECDSA P-256" },
                  { value: "rsa-3072", label: "RSA 3072" },
                  { value: "rsa-4096", label: "RSA 4096" },
                ]} />
              </Field>
              {alg.startsWith("rsa") && <div className="text-xs text-fg/45">{t("RSA 金鑰要算幾秒；舊伺服器不支援 Ed25519 時才需要。")}</div>}
              <div className="flex gap-3">
                <Field label={t("名稱")} className="flex-1">
                  <Input value={genName} onChange={(e) => setGenName(e.target.value)} placeholder={t("例如 我的筆電")} />
                </Field>
                <Field label={t("註解")} className="flex-1" hint={t("會出現在公鑰那一行的最後")}>
                  <Input value={genComment} onChange={(e) => setGenComment(e.target.value)} placeholder="me@laptop" />
                </Field>
              </div>
              <div className="flex gap-3">
                <Field label={t("密語（建議）")} className="flex-1">
                  <Input type="password" value={genPass} onChange={(e) => setGenPass(e.target.value)} placeholder={t("留空＝不加密")} />
                </Field>
                <Field label={t("再輸入一次")} className="flex-1">
                  <Input type="password" value={genPass2} onChange={(e) => setGenPass2(e.target.value)} />
                </Field>
              </div>
              {genMismatch && genPass2 && <div className="text-xs text-danger">{t("兩次輸入的密語不一樣")}</div>}
            </div>
          )
        )}
      </div>
    </Modal>
  );
}
