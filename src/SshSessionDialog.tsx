import { useEffect, useRef, useState, type ReactNode } from "react";
import { FolderOpen, SquareTerminal } from "lucide-react";
import { api, onSshAuthPrompt, onSshHostKeyPrompt } from "./api";
import { pickOpenFile, toast } from "./ui";
import { Modal, Field, Input, Button, Segmented, Select } from "./ui/index";
import { useT } from "./i18n";
import { SshAuthPromptDialog, SshHostKeyDialog } from "./SshPrompts";
import { useSshSessions } from "./sshSessions";
import {
  blankSshSession,
  type SshAuthKind,
  type SshAuthPrompt,
  type SshFolder,
  type SshHostKeyDecision,
  type SshHostKeyPrompt,
  type SshSession,
} from "./sshTypes";

// SSH 主機的新增 / 編輯對話框。沿用 ConnectionDialog 的 per-field useState + Section / Field 版型
// （src/ConnectionDialog.tsx 的 SSH Tunnel 區塊是範本）。
// 密碼語意與連線設定相同：秘密只進 OS keychain；編輯時留空 = 不變更（後端「空 = 保留」）。
// 「測試連線」走 ad_hoc target（session 不落地，密碼直接帶過去），期間的 host key / 認證提問
// 就在這個對話框上疊 SshPrompts 的兩個小對話框。

interface Props {
  open: boolean;
  initial: SshSession | null;
  folders: SshFolder[];
  /** 新增時預選的資料夾（側欄在某資料夾上按「+」）。 */
  defaultFolderId?: string | null;
  onClose: () => void;
  /** 已寫入後端後回呼；呼叫端負責同步 useSshSessions（load() 或就地 upsert）。 */
  onSaved: (s: SshSession) => void;
}

const TERM_TYPES = ["xterm-256color", "xterm", "vt100", "linux"];

export default function SshSessionDialog({ open, initial, folders, defaultFolderId, onClose, onSaved }: Props) {
  const t = useT();
  // 「編輯」= 這個 id 已經存在。側欄「複製」會帶一份新 id 的預填資料進來，那是新增，不是編輯
  // （標題、密碼欄提示、儲存後的提示都要跟著對）。
  const editing = !!initial && useSshSessions.getState().sessions.some((s) => s.id === initial.id);
  // 新主機的 id 在第一次 render 就定下來，測試連線與儲存用同一個。
  const [base] = useState<SshSession>(() => initial ?? blankSshSession(crypto.randomUUID(), defaultFolderId ?? null));
  const [name, setName] = useState(base.name);
  const [folderId, setFolderId] = useState(base.folder_id ?? "");
  const [host, setHost] = useState(base.host);
  const [port, setPort] = useState(base.port || 22);
  const [username, setUsername] = useState(base.username);
  const [auth, setAuth] = useState<SshAuthKind>(base.auth);
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(true);
  const [keyPath, setKeyPath] = useState(base.private_key_path);
  const [passphrase, setPassphrase] = useState("");
  const [rememberPassphrase, setRememberPassphrase] = useState(true);
  const [startupCommand, setStartupCommand] = useState(base.options.startup_command ?? "");
  const [term, setTerm] = useState(base.options.term || "xterm-256color");
  // v1 前端一律 UTF-8 收發，轉碼是後端的事；這裡只存值不提供選項。
  const encoding = base.options.encoding || "utf-8";
  const [keepalive, setKeepalive] = useState(base.options.keepalive_secs ?? 30);
  // 字級覆寫存 options.ui.font_size（字串）；空 = 跟隨 app 的程式碼字級。
  const [fontSize, setFontSize] = useState(base.options.ui?.font_size ?? "");
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 測試連線期間的後端提問
  const [hostKeyPrompt, setHostKeyPrompt] = useState<SshHostKeyPrompt | null>(null);
  const [authPrompt, setAuthPrompt] = useState<SshAuthPrompt | null>(null);
  const unsubRef = useRef<(() => void)[]>([]);
  // 測試中的連線 id：對話框關掉或按「取消測試」時拿它請後端放掉（否則會卡在撥號或提問最多 180 秒）。
  const testConnRef = useRef<string | null>(null);

  // 編輯時查 keychain 有沒有存密碼，決定密碼欄的提示文字。
  useEffect(() => {
    if (!open || !initial || !editing) return;
    let alive = true;
    api.sshHasStoredPassword(initial.id)
      .then((v) => {
        if (alive) setHasStoredPassword(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, initial, editing]);

  // 任一連線欄位變動就清掉上次測試結果（同 ConnectionDialog：別讓舊的「連線成功」誤導）。
  useEffect(() => {
    setMsg(null);
  }, [host, port, username, auth, password, keyPath, passphrase, term, keepalive]);

  // 卸載時把事件訂閱收掉，並取消還在跑的測試（測試進行中被關掉對話框的情況）。
  useEffect(
    () => () => {
      unsubRef.current.forEach((u) => u());
      unsubRef.current = [];
      const id = testConnRef.current;
      if (id) void api.sshDisconnect(id).catch(() => {});
    },
    [],
  );

  const cancelTest = () => {
    const id = testConnRef.current;
    if (id) void api.sshDisconnect(id).catch(() => {});
  };

  const build = (): SshSession => {
    const ui = { ...(base.options.ui ?? {}) };
    const fs = Number(fontSize);
    if (fontSize.trim() && Number.isFinite(fs) && fs > 0) ui.font_size = String(Math.round(fs));
    else delete ui.font_size;
    return {
      ...base,
      name: name.trim(),
      host: host.trim(),
      port: port > 0 ? Math.round(port) : 22,
      username: username.trim(),
      auth,
      // 非私鑰認證不留路徑：後端 plan_auth 看到路徑就會先試 key，白白多一輪失敗。
      private_key_path: auth === "key" ? keyPath.trim() : "",
      folder_id: folderId || null,
      options: {
        ...base.options,
        term: term || "xterm-256color",
        encoding,
        startup_command: startupCommand,
        keepalive_secs: Number.isFinite(keepalive) && keepalive > 0 ? Math.round(keepalive) : 0,
        ui,
      },
    };
  };

  // 這次填的秘密（沒填 = null = 後端保留既有 / 連線時詢問）。
  const typedPassword = auth === "password" && password ? password : null;
  const typedPassphrase = auth === "key" && passphrase ? passphrase : null;

  const valid = host.trim() !== "" && username.trim() !== "" && (auth !== "key" || keyPath.trim() !== "");

  const stopListening = () => {
    unsubRef.current.forEach((u) => u());
    unsubRef.current = [];
    setHostKeyPrompt(null);
    setAuthPrompt(null);
  };

  const handleTest = async () => {
    if (!valid || testing) return;
    const built = build();
    const connId = crypto.randomUUID();
    testConnRef.current = connId;
    setTesting(true);
    setMsg(null);
    const t0 = performance.now();
    try {
      // 先訂閱再連線：host key / 認證提問可能在 invoke 回來前就發出。
      unsubRef.current = await Promise.all([
        onSshHostKeyPrompt(connId, (p) => setHostKeyPrompt(p)),
        onSshAuthPrompt(connId, (p) => setAuthPrompt(p)),
      ]);
      await api.sshTest(connId, { kind: "ad_hoc", session: built, password: typedPassword, passphrase: typedPassphrase });
      const text = t("連線成功（{round} ms）", { round: Math.round(performance.now() - t0) });
      setMsg({ ok: true, text });
      toast.success(text);
    } catch (e: any) {
      // 使用者自己按了取消 / 拒絕 host key：不是錯誤，不 toast。
      if (e?.code === "ERR_SSH_CANCELLED") setMsg({ ok: false, text: t("已取消") });
      else setMsg({ ok: false, text: e?.message ?? t("連線失敗") });
    } finally {
      testConnRef.current = null;
      stopListening();
      setTesting(false);
    }
  };

  const answerHostKey = (decision: SshHostKeyDecision) => {
    const p = hostKeyPrompt;
    setHostKeyPrompt(null);
    if (p) api.sshHostkeyAnswer(p.prompt_id, decision).catch((e: any) => toast.error(e?.message ?? String(e)));
  };
  const answerAuth = (answers: string[] | null) => {
    const p = authPrompt;
    setAuthPrompt(null);
    if (p) api.sshAuthAnswer(p.prompt_id, answers).catch((e: any) => toast.error(e?.message ?? String(e)));
  };

  const handleSave = async () => {
    if (!valid || saving) return;
    const built = build();
    setSaving(true);
    try {
      await api.sshSessionSave(built, rememberPassword ? typedPassword : null, rememberPassphrase ? typedPassphrase : null);
      onSaved(built);
    } catch (e: any) {
      toast.error(e?.message ?? t("儲存失敗"));
    } finally {
      setSaving(false);
    }
  };

  // 文字輸入按 Enter 直接儲存（與其他對話框一致）。
  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing && valid) {
      e.preventDefault();
      void handleSave();
    }
  };

  const browseKey = async () => {
    const p = await pickOpenFile();
    if (p) setKeyPath(p);
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={editing ? t("編輯 SSH 主機") : t("新增 SSH 主機")}
        icon={SquareTerminal}
        size="lg"
        zClass="z-50"
        bodyClassName="p-5 space-y-3 overflow-auto"
        footer={
          <>
            {testing ? (
              <Button variant="secondary" className="mr-auto" loading onClick={cancelTest} title={t("取消測試連線")}>
                {t("取消測試")}
              </Button>
            ) : (
              <Button variant="secondary" className="mr-auto" disabled={!valid} onClick={handleTest}>
                {t("測試連線")}
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
            <Button variant="primary" onClick={handleSave} disabled={!valid} loading={saving}>{t("儲存")}</Button>
          </>
        }
      >
        <Field label={t("名稱")}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={submitOnEnter}
            placeholder={t("留空＝使用者@主機")}
          />
        </Field>
        <Field label={t("資料夾")}>
          <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">{t("未分類")}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-3">
          <Field label={t("主機")} className="flex-1" required>
            <Input value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={submitOnEnter} placeholder="10.0.0.12" />
          </Field>
          <Field label={t("埠")} className="w-24">
            <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} onKeyDown={submitOnEnter} />
          </Field>
        </div>
        <Field label={t("使用者")} required>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} placeholder="deploy" />
        </Field>
        <Field label={t("認證方式")}>
          <Segmented
            full
            ariaLabel={t("認證方式")}
            value={auth}
            onChange={setAuth}
            options={[
              { value: "password", label: t("密碼") },
              { value: "key", label: t("私鑰") },
              { value: "agent", label: "ssh-agent" },
              { value: "keyboard_interactive", label: t("鍵盤互動") },
            ]}
          />
        </Field>

        {auth === "password" && (
          <>
            <Field label={t("密碼")}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={editing && hasStoredPassword ? t("已儲存，留空則不變更") : t("留空＝連線時詢問")}
              />
            </Field>
            <Checkbox checked={rememberPassword} onChange={setRememberPassword} label={t("記住密碼")} hint={t("存進系統鑰匙圈，不寫入設定檔")} />
          </>
        )}
        {auth === "key" && (
          <>
            <Field label={t("私鑰檔路徑")} required>
              <div className="flex gap-2">
                <Input
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  onKeyDown={submitOnEnter}
                  placeholder={t("例如 C:\\\\Users\\\\me\\\\.ssh\\\\id_ed25519")}
                />
                <Button variant="secondary" icon={FolderOpen} onClick={browseKey} title={t("瀏覽…")} className="shrink-0">
                  {t("瀏覽")}
                </Button>
              </div>
            </Field>
            <Field label={t("私鑰密語（選填）")}>
              <Input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={editing ? t("留空＝不變更") : t("留空＝需要時詢問")}
              />
            </Field>
            <Checkbox checked={rememberPassphrase} onChange={setRememberPassphrase} label={t("記住密語")} hint={t("存進系統鑰匙圈，不寫入設定檔")} />
          </>
        )}
        {auth === "agent" && (
          <div className="text-xs text-fg/50">
            {t("使用系統的 ssh-agent（Unix 的 SSH_AUTH_SOCK；Windows 的 OpenSSH agent 或 Pageant），不需在此填密碼。")}
          </div>
        )}
        {auth === "keyboard_interactive" && (
          <div className="text-xs text-fg/50">{t("連線時依伺服器的提問逐項輸入（OTP / 二階段驗證常用）。")}</div>
        )}

        <Section title={t("終端機")}>
          <Field label={t("啟動指令")} hint={t("連線成功後自動送出，例如 cd /var/www && ls")}>
            <Input value={startupCommand} onChange={(e) => setStartupCommand(e.target.value)} onKeyDown={submitOnEnter} className="mono" />
          </Field>
          <div className="flex gap-3">
            <Field label={t("終端類型")} className="flex-1">
              <Select value={term} onChange={(e) => setTerm(e.target.value)}>
                {TERM_TYPES.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("編碼")} className="flex-1" hint={t("目前僅支援 UTF-8；非 UTF-8 主機請在遠端設定 locale")}>
              <Select value="utf-8" disabled>
                <option value="utf-8">UTF-8</option>
              </Select>
            </Field>
          </div>
          <div className="flex gap-3">
            <Field label={t("Keepalive（秒）")} className="flex-1" hint={t("0＝停用")}>
              <Input type="number" min={0} value={keepalive} onChange={(e) => setKeepalive(Number(e.target.value))} onKeyDown={submitOnEnter} />
            </Field>
            <Field label={t("字級覆寫")} className="flex-1" hint={t("留空＝跟隨 app 的程式碼字級")}>
              <Input
                type="number"
                min={8}
                max={40}
                value={fontSize}
                onChange={(e) => setFontSize(e.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={t("跟隨 app")}
              />
            </Field>
          </div>
        </Section>

        {msg && <div className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</div>}
      </Modal>

      {hostKeyPrompt && <SshHostKeyDialog info={hostKeyPrompt} onReply={answerHostKey} />}
      {authPrompt && (
        <SshAuthPromptDialog prompt={authPrompt} onReply={(a) => answerAuth(a)} onCancel={() => answerAuth(null)} />
      )}
    </>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      {hint && <span className="text-xs text-fg/40">{hint}</span>}
    </label>
  );
}

// 與 ConnectionDialog 的 Section 同款（上緣分隔線 + 小標）；它沒有匯出，這裡照抄一份。
function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="border-t border-fg/10 pt-3 space-y-2.5">
      {title && <div className="text-xs font-medium text-fg/50">{title}</div>}
      {children}
    </div>
  );
}
