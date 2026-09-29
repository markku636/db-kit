import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FolderOpen, SquareTerminal } from "lucide-react";
import { api, onSshAuthPrompt, onSshHostKeyPrompt } from "./api";
import { pickOpenFile, toast } from "./ui";
import { Modal, Field, Input, Button, Icon, Segmented, Select } from "./ui/index";
import { useT } from "./i18n";
import { SshAuthPromptDialog, SshHostKeyDialog } from "./SshPrompts";
import SshKeyPathField from "./SshKeyPathField";
import { jumpChoices, sessionLabel, useSshSessions } from "./sshSessions";
import { applySshString, parseSshString, type ApplySshResult, type ParsedSsh, type SshFormFields } from "./sshConnString";
import {
  blankSshSession,
  defaultPortFor,
  type FtpTls,
  type HostProtocol,
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
// 同一個對話框也管 FTP 主機（上方切換協定）：FTP 只有帳號密碼、加密方式與傳輸模式，SSH 專屬的欄位
// （認證方式、跳板機、終端機設定）不顯示。

interface Props {
  open: boolean;
  initial: SshSession | null;
  folders: SshFolder[];
  /** 新增時預選的資料夾（側欄在某資料夾上按「+」）。 */
  defaultFolderId?: string | null;
  onClose: () => void;
  /** 已寫入後端後回呼；呼叫端負責同步 useSshSessions（load() 或就地 upsert）。 */
  onSaved: (s: SshSession) => void;
  /** 新增連線對話框轉交過來的 ssh:// / sftp:// 字串（已解析）：開啟時先套進欄位。 */
  prefill?: ParsedSsh | null;
  /** 新增時提供「從 ~/.ssh/config、.xsh 匯入」的入口（側欄 SSH 區塊沒有主機時不顯示，這裡是唯一入口）。 */
  onImport?: () => void;
}

const TERM_TYPES = ["xterm-256color", "xterm", "vt100", "linux"];

export default function SshSessionDialog({ open, initial, folders, defaultFolderId, onClose, onSaved, prefill, onImport }: Props) {
  const t = useT();
  // 「編輯」= 這個 id 已經存在。側欄「複製」會帶一份新 id 的預填資料進來，那是新增，不是編輯
  // （標題、密碼欄提示、儲存後的提示都要跟著對）。
  const editing = !!initial && useSshSessions.getState().sessions.some((s) => s.id === initial.id);
  // 新主機的 id 在第一次 render 就定下來，測試連線與儲存用同一個。
  const [base] = useState<SshSession>(() => initial ?? blankSshSession(crypto.randomUUID(), defaultFolderId ?? null));
  // 連線字串能填到的欄位先算好一份（帶了 prefill 就先套上去），下面各欄位從這份初始化。
  const [init] = useState<ApplySshResult>(() => {
    const protocol: HostProtocol = base.protocol ?? "ssh";
    const ftpTls: FtpTls = base.ftp?.tls ?? "explicit";
    const fields: SshFormFields = {
      protocol,
      ftpTls,
      host: base.host,
      port: base.port || defaultPortFor(protocol, ftpTls),
      username: base.username,
      auth: base.auth,
      password: "",
      keyPath: base.private_key_path,
      jumpId: base.jump_session_id ?? "",
      openSftp: base.options.ui?.open_sftp === "1",
      sftpDir: base.options.ui?.sftp_dir ?? "",
    };
    return prefill
      ? applySshString(prefill, fields, jumpChoices(useSshSessions.getState().sessions, base.id))
      : { next: fields, jumpMissing: null };
  });
  const [protocol, setProtocol] = useState<HostProtocol>(init.next.protocol);
  const ftp = protocol === "ftp";
  const [ftpTls, setFtpTls] = useState<FtpTls>(init.next.ftpTls);
  const [ftpActive, setFtpActive] = useState(base.ftp?.active ?? false);
  const [name, setName] = useState(base.name);
  const [folderId, setFolderId] = useState(base.folder_id ?? "");
  const [host, setHost] = useState(init.next.host);
  const [port, setPort] = useState(init.next.port);
  const [username, setUsername] = useState(init.next.username);
  // 跳板機（ProxyJump）：另一台已存主機；"" = 直連。
  const [jumpId, setJumpId] = useState(init.next.jumpId);
  const allSessions = useSshSessions((s) => s.sessions);
  const jumpOptions = jumpChoices(allSessions, base.id);
  const [auth, setAuth] = useState<SshAuthKind>(init.next.auth);
  const [password, setPassword] = useState(init.next.password);
  const [rememberPassword, setRememberPassword] = useState(true);
  const [keyPath, setKeyPath] = useState(init.next.keyPath);
  // OpenSSH 使用者憑證；空 = 找私鑰旁邊的 <私鑰>-cert.pub（舊存檔沒有這個欄位）。
  const [certPath, setCertPath] = useState(base.certificate_path ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [rememberPassphrase, setRememberPassphrase] = useState(true);
  const [startupCommand, setStartupCommand] = useState(base.options.startup_command ?? "");
  const [term, setTerm] = useState(base.options.term || "xterm-256color");
  // v1 前端一律 UTF-8 收發，轉碼是後端的事；這裡只存值不提供選項。
  const encoding = base.options.encoding || "utf-8";
  const [keepalive, setKeepalive] = useState(base.options.keepalive_secs ?? 30);
  // 字級覆寫存 options.ui.font_size（字串）；空 = 跟隨 app 的程式碼字級。
  const [fontSize, setFontSize] = useState(base.options.ui?.font_size ?? "");
  // SFTP：開啟這台時一併展開 SFTP 面板（sftp:// 字串建的主機預設開），以及面板的起始資料夾。
  // 存 options.ui（前端自己的設定，後端不解讀）。
  const [openSftp, setOpenSftp] = useState(init.next.openSftp);
  const [sftpDir, setSftpDir] = useState(init.next.sftpDir);
  // 進階設定（SFTP、終端機）預設收起，常用欄位一個畫面就看得完；有任何非預設值（或從 sftp:// 字串來）就先展開，
  // 免得設過的東西藏起來看不到。
  const [advOpen, setAdvOpen] = useState(() =>
    init.next.openSftp
    || !!init.next.sftpDir
    || !!base.ftp?.active
    || !!base.options.startup_command
    || (base.options.term || "xterm-256color") !== "xterm-256color"
    || (base.options.keepalive_secs ?? 30) !== 30
    || !!base.options.ui?.font_size);
  // 「已依連線字串填入」的提示；跳板機對不到已存主機時一併說明。
  const fillNotice = (r: ApplySshResult) => ({
    ok: !r.jumpMissing,
    text: r.jumpMissing
      ? t("已依連線字串填入。找不到跳板機「{jump}」，請從清單選擇", { jump: r.jumpMissing })
      : t("已依連線字串填入，請確認後儲存"),
  });
  // 「FTP / FTPS」卡片帶來的是沒有主機的空白預填（只為了預選協定），不算「依連線字串填入」。
  const [filled, setFilled] = useState<{ ok: boolean; text: string } | null>(() => (prefill?.host ? fillNotice(init) : null));
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
  }, [protocol, ftpTls, ftpActive, host, port, username, auth, password, keyPath, certPath, passphrase, term, keepalive, jumpId]);

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

  // 換協定 / 加密方式：埠還是舊設定的預設值就跟著換（22 ↔ 21 ↔ 990），使用者自己改過的埠不動。
  const switchProtocol = (p: HostProtocol) => {
    if (p === protocol) return;
    if (port === defaultPortFor(protocol, ftpTls)) setPort(defaultPortFor(p, ftpTls));
    setProtocol(p);
  };
  const switchTls = (v: FtpTls) => {
    if (port === defaultPortFor("ftp", ftpTls)) setPort(defaultPortFor("ftp", v));
    setFtpTls(v);
  };

  const cancelTest = () => {
    const id = testConnRef.current;
    if (id) void api.sshDisconnect(id).catch(() => {});
  };

  const build = (): SshSession => {
    const ui = { ...(base.options.ui ?? {}) };
    const fs = Number(fontSize);
    if (fontSize.trim() && Number.isFinite(fs) && fs > 0) ui.font_size = String(Math.round(fs));
    else delete ui.font_size;
    if (openSftp && !ftp) ui.open_sftp = "1";
    else delete ui.open_sftp;
    if (sftpDir.trim()) ui.sftp_dir = sftpDir.trim();
    else delete ui.sftp_dir;
    return {
      ...base,
      name: name.trim(),
      host: host.trim(),
      port: port > 0 ? Math.round(port) : defaultPortFor(protocol, ftpTls),
      username: username.trim(),
      auth: ftp ? "password" : auth,
      // 非私鑰認證不留路徑：後端 plan_auth 看到路徑就會先試 key，白白多一輪失敗。
      private_key_path: !ftp && auth === "key" ? keyPath.trim() : "",
      certificate_path: !ftp && auth === "key" ? certPath.trim() : "",
      jump_session_id: ftp ? null : jumpId || null,
      folder_id: folderId || null,
      options: {
        ...base.options,
        term: term || "xterm-256color",
        encoding,
        startup_command: startupCommand,
        keepalive_secs: Number.isFinite(keepalive) && keepalive > 0 ? Math.round(keepalive) : 0,
        ui,
      },
      // 從 FTP 改回 SSH 要明講（base 帶著舊值）；一直是 SSH 的主機不多寫這個欄位。
      protocol: ftp ? "ftp" : base.protocol ? "ssh" : undefined,
      ftp: ftp ? { tls: ftpTls, active: ftpActive } : base.ftp,
    };
  };

  // 這次填的秘密（沒填 = null = 後端保留既有 / 連線時詢問）。
  const typedPassword = (ftp || auth === "password") && password ? password : null;
  const typedPassphrase = !ftp && auth === "key" && passphrase ? passphrase : null;

  // FTP 的帳號可以留空（匿名登入）。
  const valid = ftp
    ? host.trim() !== ""
    : host.trim() !== "" && username.trim() !== "" && (auth !== "key" || keyPath.trim() !== "");

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

  // 主機 / 名稱欄的貼上攔截：貼進來的是 SSH 字串就拆進各欄位，而不是整串倒進欄位。
  // 主機欄另收沒有 scheme 的 user@host:port（那一欄只收主機，帶 @ 或埠號一定是想連這台）；
  // 名稱欄只收明確的 ssh:// / sftp:// / ssh 指令——「deploy@web」當名稱是合理的。
  const pasteInto = (bare: boolean) => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const p = parseSshString(e.clipboardData.getData("text"), { bare });
    if (!p) return;
    e.preventDefault();
    const r = applySshString(
      p,
      { protocol, ftpTls, host, port, username, auth, password, keyPath, jumpId, openSftp, sftpDir },
      jumpOptions,
    );
    const f = r.next;
    setProtocol(f.protocol); setFtpTls(f.ftpTls);
    setHost(f.host); setPort(f.port); setUsername(f.username); setAuth(f.auth); setPassword(f.password);
    setKeyPath(f.keyPath); setJumpId(f.jumpId); setOpenSftp(f.openSftp); setSftpDir(f.sftpDir);
    if (f.openSftp || f.sftpDir) setAdvOpen(true); // 字串帶了 SFTP 設定：展開給使用者看見
    setFilled(fillNotice(r));
  };

  const browseCert = async () => {
    const p = await pickOpenFile();
    if (p) setCertPath(p);
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={editing ? (ftp ? t("編輯 FTP 主機") : t("編輯 SSH 主機")) : ftp ? t("新增 FTP 主機") : t("新增 SSH 主機")}
        icon={ftp ? FolderOpen : SquareTerminal}
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
        {/* 流動排版：一列放兩三個欄位，對話框窄時自動往下一行掉（各欄位有最小寬度）。
            常用欄位一個畫面看得完；SFTP / 終端機設定收在「進階設定」。 */}
        {!editing && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg/45">
            <span className="min-w-0 flex-1 basis-64">{t("可在「主機」直接貼上 ssh://、sftp://、ftp:// 或 ssh 指令（ssh -p 2222 user@host）")}</span>
            {onImport && (
              <button type="button" onClick={onImport} className="shrink-0 text-accent hover:underline">
                {t("從 ~/.ssh/config、.xsh 匯入…")}
              </button>
            )}
          </div>
        )}
        <Field label={t("協定")}>
          <Segmented
            full
            ariaLabel={t("協定")}
            value={protocol}
            onChange={switchProtocol}
            options={[
              { value: "ssh", label: t("SSH / SFTP（終端機與檔案）") },
              { value: "ftp", label: t("FTP / FTPS（只有檔案）") },
            ]}
          />
        </Field>
        <div className="flex flex-wrap gap-x-3 gap-y-3">
          <Field label={t("名稱")} className="flex-[3] min-w-[14rem]">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={submitOnEnter}
              onPaste={pasteInto(false)}
              placeholder={t("留空＝使用者@主機")}
            />
          </Field>
          <Field label={t("資料夾")} className="flex-[2] min-w-[10rem]">
            <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">{t("未分類")}</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-3">
          <Field label={t("主機")} className="flex-1 min-w-[14rem]" required>
            <Input
              value={host}
              onChange={(e) => { setHost(e.target.value); setFilled(null); }}
              onKeyDown={submitOnEnter}
              onPaste={pasteInto(true)}
              aria-label={t("主機")}
              placeholder="10.0.0.12"
            />
          </Field>
          <Field label={t("埠")} className="w-24">
            <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} onKeyDown={submitOnEnter} aria-label={t("埠")} />
          </Field>
        </div>
        {filled && <div className={`text-xs ${filled.ok ? "text-success" : "text-warning"}`}>{filled.text}</div>}
        {ftp ? (
          <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
            <Field label={t("使用者")} className="flex-[2] min-w-[10rem]">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} placeholder={t("留空＝匿名登入")} aria-label={t("使用者")} />
            </Field>
            <Field label={t("加密")} className="flex-[3] min-w-[14rem]"
              hint={ftpTls === "none"
                ? <span className="text-warning">{t("密碼與檔案內容都會以明文傳送，只在信任的網路上使用。")}</span>
                : ftpTls === "implicit" ? t("舊式：連上就走 TLS，通常是 990 埠。") : t("連上後用 AUTH TLS 加密；伺服器不支援就會連線失敗，不會退回明文。")}>
              <Select value={ftpTls} onChange={(e) => switchTls(e.target.value as FtpTls)} aria-label={t("加密")}>
                <option value="explicit">{t("需要 explicit FTP over TLS（建議）")}</option>
                <option value="implicit">{t("implicit FTP over TLS")}</option>
                <option value="none">{t("只用一般 FTP（不加密）")}</option>
              </Select>
            </Field>
          </div>
        ) : (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
          <Field label={t("使用者")} className="flex-[2] min-w-[10rem]" required>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} placeholder="deploy" aria-label={t("使用者")} />
          </Field>
          {/* 跳板機只能選「已存的另一台主機」。一台都沒有（例如正在新增第一台）時，清單只剩「直連」，
              看起來像功能沒做——這時停用下拉，提示改成告訴使用者該怎麼做。 */}
          <Field label={t("跳板機")} className="flex-[3] min-w-[14rem]"
            hint={jumpOptions.length || jumpId
              ? t("先連上這台，再經由它連到目標主機（ProxyJump）。跳板機要允許 TCP 轉送。")
              : t("還沒有其他主機可當跳板機：先把跳板機新增成一台主機，這裡就能選它。")}>
            <Select value={jumpId} onChange={(e) => setJumpId(e.target.value)} aria-label={t("跳板機")}
              disabled={!jumpOptions.length && !jumpId}>
              <option value="">{t("不經跳板機（直連）")}</option>
              {jumpOptions.map((s) => (
                <option key={s.id} value={s.id}>{sessionLabel(s)}{s.name ? `（${s.username}@${s.host}）` : ""}</option>
              ))}
              {jumpId && !allSessions.some((s) => s.id === jumpId) && <option value={jumpId}>{t("（已刪除的主機）")}</option>}
            </Select>
          </Field>
        </div>
        )}
        {!ftp && (
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
        )}

        {(ftp || auth === "password") && (
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
        {!ftp && auth === "key" && (
          <>
            <Field label={t("私鑰")} required>
              <SshKeyPathField value={keyPath} onChange={setKeyPath} passphrase={passphrase} certificatePath={certPath} onKeyDown={submitOnEnter} />
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
            <Field label={t("OpenSSH 憑證（選填）")} hint={t("留空＝自動找私鑰旁邊的 <私鑰>-cert.pub")}>
              <div className="flex gap-2">
                <Input value={certPath} onChange={(e) => setCertPath(e.target.value)} onKeyDown={submitOnEnter} placeholder={t("自動")} aria-label={t("OpenSSH 憑證（選填）")} />
                <Button variant="secondary" icon={FolderOpen} onClick={browseCert} title={t("瀏覽…")} className="shrink-0">
                  {t("瀏覽")}
                </Button>
              </div>
            </Field>
          </>
        )}
        {!ftp && auth === "agent" && (
          <div className="text-xs text-fg/50">
            {t("使用系統的 ssh-agent（Unix 的 SSH_AUTH_SOCK；Windows 的 OpenSSH agent 或 Pageant），不需在此填密碼。")}
          </div>
        )}
        {!ftp && auth === "keyboard_interactive" && (
          <div className="text-xs text-fg/50">{t("連線時依伺服器的提問逐項輸入（OTP / 二階段驗證常用）。")}</div>
        )}

        <div className="border-t border-fg/10 pt-2">
          <button type="button" onClick={() => setAdvOpen((v) => !v)} aria-expanded={advOpen}
            className="flex items-center gap-1 text-xs font-medium text-fg/50 hover:text-fg/80">
            <Icon icon={advOpen ? ChevronDown : ChevronRight} size={13} />
            {ftp ? t("進階設定（起始資料夾、傳輸模式）") : t("進階設定（SFTP、終端機）")}
          </button>
        </div>
        {advOpen && ftp && (
          <Section>
            <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
              <Field label={t("起始資料夾")} className="flex-1 min-w-[14rem]" hint={t("留空＝登入後所在的資料夾")}>
                <Input value={sftpDir} onChange={(e) => setSftpDir(e.target.value)} onKeyDown={submitOnEnter} className="mono" placeholder="/" aria-label={t("起始資料夾")} />
              </Field>
              <Field label={t("傳輸模式")} className="flex-1 min-w-[14rem]"
                hint={t("被動模式在 NAT / 防火牆後面也能用；伺服器不支援被動模式時才改主動。")}>
                <Segmented
                  full
                  ariaLabel={t("傳輸模式")}
                  value={ftpActive ? "active" : "passive"}
                  onChange={(v) => setFtpActive(v === "active")}
                  options={[
                    { value: "passive", label: t("被動") },
                    { value: "active", label: t("主動") },
                  ]}
                />
              </Field>
            </div>
          </Section>
        )}
        {advOpen && !ftp && (
          <>
            <Section title="SFTP">
              <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                <Field label={t("SFTP 起始資料夾")} className="flex-1 min-w-[14rem]" hint={t("留空＝家目錄；~/ 開頭＝家目錄底下")}>
                  <Input value={sftpDir} onChange={(e) => setSftpDir(e.target.value)} onKeyDown={submitOnEnter} className="mono" placeholder="~" aria-label={t("SFTP 起始資料夾")} />
                </Field>
                {/* 與輸入框同一條基準線（Field 的提示字在下面，所以往上墊一點）。 */}
                <div className="pb-6">
                  <Checkbox checked={openSftp} onChange={setOpenSftp} label={t("開啟時一併展開 SFTP 面板")} />
                </div>
              </div>
            </Section>

            <Section title={t("終端機")}>
              <Field label={t("啟動指令")} hint={t("連線成功後自動送出，例如 cd /var/www && ls")}>
                <Input value={startupCommand} onChange={(e) => setStartupCommand(e.target.value)} onKeyDown={submitOnEnter} className="mono" />
              </Field>
              <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
                <Field label={t("終端類型")} className="flex-1 min-w-[9rem]">
                  <Select value={term} onChange={(e) => setTerm(e.target.value)}>
                    {TERM_TYPES.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("編碼")} className="flex-1 min-w-[9rem]" hint={t("目前僅支援 UTF-8；非 UTF-8 主機請在遠端設定 locale")}>
                  <Select value="utf-8" disabled>
                    <option value="utf-8">UTF-8</option>
                  </Select>
                </Field>
                <Field label={t("Keepalive（秒）")} className="flex-1 min-w-[9rem]" hint={t("0＝停用")}>
                  <Input type="number" min={0} value={keepalive} onChange={(e) => setKeepalive(Number(e.target.value))} onKeyDown={submitOnEnter} />
                </Field>
                <Field label={t("字級覆寫")} className="flex-1 min-w-[9rem]" hint={t("留空＝跟隨 app 的程式碼字級")}>
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
          </>
        )}

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
