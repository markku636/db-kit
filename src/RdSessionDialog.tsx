import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Monitor } from "lucide-react";
import { api } from "./api";
import { toast } from "./ui";
import { Modal, Field, Input, Button, Icon, Segmented, Select } from "./ui/index";
import { useT } from "./i18n";
import { sessionLabel, useSshSessions } from "./sshSessions";
import { useRdSessions } from "./rdSessions";
import { applyRdString, parseRdString, type ParsedRd } from "./rdConnString";
import {
  blankRdSession, defaultRdPort,
  type RdFolder, type RdProtocol, type RdResizeMode, type RdSession, type VncSecurity,
} from "./rdTypes";
import { isFtpHost, type SshSession } from "./sshTypes";

// 遠端桌面主機（RDP / VNC / RustDesk）的新增 / 編輯對話框。版型同 SshSessionDialog（流動排版 + 進階設定收合）。
// 密碼只進 OS keychain；編輯時留空 = 不變更。主機 / 名稱欄貼上 rdp:// vnc:// rustdesk:// mstsc 字串會拆進各欄位。

interface Props {
  open: boolean;
  initial: RdSession | null;
  folders: RdFolder[];
  defaultFolderId?: string | null;
  /** 新增時的預設協定（KindPicker 點了哪張卡）。 */
  defaultProtocol?: RdProtocol;
  onClose: () => void;
  /** 已寫入後端；`connect` = 按的是「儲存並連線」。 */
  onSaved: (s: RdSession, connect: boolean) => void;
  /** 連線字串 / .rdp 檔已解析的結果：開啟時先套進欄位。 */
  prefill?: ParsedRd | null;
}

/** 連線字串帶的 SshHost 對到已存 SSH 主機（主機名 + 帳號 + 埠都要符合；帳號沒給就只比主機 + 埠）。 */
function matchSsh(sessions: SshSession[], via: ParsedRd["viaSsh"]): SshSession | null {
  if (!via) return null;
  const h = via.host.toLowerCase();
  return sessions.find((s) => s.host.toLowerCase() === h && (s.port || 22) === (via.port || 22) && (!via.username || s.username === via.username)) ?? null;
}

export default function RdSessionDialog({ open, initial, folders, defaultFolderId, defaultProtocol, onClose, onSaved, prefill }: Props) {
  const t = useT();
  const editing = !!initial && useRdSessions.getState().sessions.some((s) => s.id === initial.id);
  // 經主機轉接只能用 SSH 主機（同一份清單裡也有 FTP 主機）。
  const allHosts = useSshSessions((s) => s.sessions);
  const sshSessions = useMemo(() => allHosts.filter((s) => !isFtpHost(s)), [allHosts]);
  const [init] = useState<{ s: RdSession; password: string; notice: { ok: boolean; text: string } | null }>(() => {
    let s = initial ?? blankRdSession(crypto.randomUUID(), prefill?.protocol ?? defaultProtocol ?? "rdp", defaultFolderId ?? null);
    let notice: { ok: boolean; text: string } | null = null;
    if (prefill) {
      s = applyRdString(s, prefill);
      const ssh = matchSsh(useSshSessions.getState().sessions.filter((x) => !isFtpHost(x)), prefill.viaSsh);
      if (ssh) s = { ...s, via_ssh_session_id: ssh.id };
      const warn = [...prefill.warnings];
      if (prefill.viaSsh && !ssh) warn.push(t("找不到 SSH 主機 {host}，請先新增它，再從「經 SSH 主機連線」選擇", { host: prefill.viaSsh.host }));
      notice = warn.length ? { ok: false, text: warn.join("；") } : { ok: true, text: t("已依連線字串填入，請確認後儲存") };
    }
    return { s, password: prefill?.password ?? "", notice };
  });
  const base = init.s;
  const [protocol, setProtocol] = useState<RdProtocol>(base.protocol);
  const [name, setName] = useState(base.name);
  const [folderId, setFolderId] = useState(base.folder_id ?? "");
  const [host, setHost] = useState(base.host);
  const [port, setPort] = useState<number>(base.port);
  const [username, setUsername] = useState(base.username);
  const [domain, setDomain] = useState(base.domain);
  const [password, setPassword] = useState(init.password);
  const [remember, setRemember] = useState(true);
  const [viaSsh, setViaSsh] = useState(base.via_ssh_session_id ?? "");
  const o = base.options;
  const [resizeMode, setResizeMode] = useState<RdResizeMode>(o.resize_mode);
  const [colorDepth, setColorDepth] = useState<number>(o.color_depth || 32);
  const [width, setWidth] = useState<number>(o.width);
  const [height, setHeight] = useState<number>(o.height);
  const [nla, setNla] = useState(o.nla);
  const [viewOnly, setViewOnly] = useState(o.view_only);
  const [clipboard, setClipboard] = useState(o.clipboard);
  const [vncSecurity, setVncSecurity] = useState<VncSecurity>(o.vnc_security);
  const [vncShared, setVncShared] = useState(o.vnc_shared);
  const [rdServer, setRdServer] = useState(o.rustdesk_server);
  const [rdKey, setRdKey] = useState(o.rustdesk_key);
  const [rdRelay, setRdRelay] = useState(o.rustdesk_relay);
  const [fullscreen, setFullscreen] = useState(o.ui?.fullscreen === "1");
  const [filled, setFilled] = useState(init.notice);
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [advOpen, setAdvOpen] = useState(() =>
    o.resize_mode !== "scale" || !o.nla || o.view_only || !o.clipboard || o.vnc_security !== "auto"
    || !!o.width || !!o.rustdesk_server || o.ui?.fullscreen === "1");

  useEffect(() => {
    if (!open || !initial || !editing) return;
    let alive = true;
    api.rdHasStoredPassword(initial.id).then((v) => { if (alive) setHasStoredPassword(v); }).catch(() => {});
    return () => { alive = false; };
  }, [open, initial, editing]);

  const build = (): RdSession => {
    const ui = { ...(o.ui ?? {}) };
    if (fullscreen) ui.fullscreen = "1";
    else delete ui.fullscreen;
    return {
      ...base,
      protocol,
      name: name.trim(),
      host: protocol === "rustdesk" ? host.replace(/\s+/g, "") : host.trim(),
      port: port > 0 ? Math.round(port) : 0,
      username: username.trim(),
      domain: protocol === "rdp" ? domain.trim() : "",
      via_ssh_session_id: viaSsh || null,
      folder_id: folderId || null,
      options: {
        ...o,
        resize_mode: resizeMode,
        color_depth: colorDepth,
        width: width > 0 ? Math.round(width) : 0,
        height: height > 0 ? Math.round(height) : 0,
        nla,
        view_only: viewOnly,
        clipboard,
        vnc_security: vncSecurity,
        vnc_shared: vncShared,
        rustdesk_server: rdServer.trim(),
        rustdesk_key: rdKey.trim(),
        rustdesk_relay: rdRelay,
        ui,
      },
    };
  };

  const valid = host.trim() !== "";

  const save = async (connect: boolean) => {
    if (!valid || saving) return;
    const built = build();
    setSaving(true);
    try {
      await useRdSessions.getState().save(built, remember && password ? password : null);
      onSaved(built, connect);
    } catch (e) {
      toast.error((e as Error)?.message ?? t("儲存失敗"));
    } finally {
      setSaving(false);
    }
  };

  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing && valid) {
      e.preventDefault();
      void save(false);
    }
  };

  // 主機 / 名稱欄貼上連線字串：拆進各欄位，而不是整串倒進去。
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const p = parseRdString(e.clipboardData.getData("text"));
    if (!p) return;
    e.preventDefault();
    const next = applyRdString(build(), p);
    setProtocol(next.protocol); setHost(next.host); setPort(next.port); setUsername(next.username); setDomain(next.domain);
    if (!name.trim() && next.name) setName(next.name);
    const no = next.options;
    setResizeMode(no.resize_mode); setColorDepth(no.color_depth); setWidth(no.width); setHeight(no.height); setNla(no.nla);
    setViewOnly(no.view_only); setVncSecurity(no.vnc_security); setRdServer(no.rustdesk_server); setRdKey(no.rustdesk_key);
    setRdRelay(no.rustdesk_relay); setFullscreen(no.ui?.fullscreen === "1");
    if (p.password) setPassword(p.password);
    const ssh = matchSsh(sshSessions, p.viaSsh);
    if (ssh) setViaSsh(ssh.id);
    const warn = [...p.warnings];
    if (p.viaSsh && !ssh) warn.push(t("找不到 SSH 主機 {host}，請先新增它，再從「經 SSH 主機連線」選擇", { host: p.viaSsh.host }));
    setFilled(warn.length ? { ok: false, text: warn.join("；") } : { ok: true, text: t("已依連線字串填入，請確認後儲存") });
  };

  const isRd = protocol === "rustdesk";
  const hostLabel = isRd ? t("對方 ID") : t("主機");
  const hostPlaceholder = protocol === "rdp" ? "10.0.0.20" : protocol === "vnc" ? "mac-mini.local" : "123 456 789";
  const userHint =
    protocol === "vnc" ? t("連 Mac 螢幕共享填 Mac 的登入帳號；一般 VNC 只要密碼可留空") :
    protocol === "rdp" ? t("可寫成 DOMAIN\\user；留空＝連線時詢問") : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t("編輯遠端桌面") : t("新增遠端桌面")}
      icon={Monitor}
      size="lg"
      zClass="z-50"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={
        <>
          <Button variant="secondary" className="mr-auto" onClick={onClose}>{t("取消")}</Button>
          <Button variant="secondary" onClick={() => void save(false)} disabled={!valid} loading={saving}>{t("儲存")}</Button>
          <Button variant="primary" onClick={() => void save(true)} disabled={!valid || saving}>{t("儲存並連線")}</Button>
        </>
      }
    >
      {!editing && (
        <div className="text-xs text-fg/45">{t("可在「主機」直接貼上 rdp://、vnc://、rustdesk:// 或 mstsc /v: 連線字串")}</div>
      )}
      <Field label={t("協定")}>
        <Segmented
          full
          ariaLabel={t("協定")}
          value={protocol}
          onChange={setProtocol}
          options={[
            { value: "rdp", label: t("RDP（Windows 遠端桌面）") },
            { value: "vnc", label: t("VNC / Mac 螢幕共享") },
            { value: "rustdesk", label: "RustDesk" },
          ]}
        />
      </Field>
      <div className="flex flex-wrap gap-x-3 gap-y-3">
        <Field label={t("名稱")} className="flex-[3] min-w-[14rem]">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={submitOnEnter} onPaste={onPaste}
            placeholder={t("留空＝使用者@主機")} />
        </Field>
        <Field label={t("資料夾")} className="flex-[2] min-w-[10rem]">
          <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
            <option value="">{t("未分類")}</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-3">
        <Field label={hostLabel} className="flex-1 min-w-[14rem]" required
          hint={isRd ? t("對方電腦的 IP 位址（Direct IP）；用 RustDesk ID 連線會在之後的版本支援") : undefined}>
          <Input value={host} onChange={(e) => { setHost(e.target.value); setFilled(null); }} onKeyDown={submitOnEnter} onPaste={onPaste}
            aria-label={hostLabel} placeholder={hostPlaceholder} />
        </Field>
        <Field label={t("埠")} className="w-28">
          <Input type="number" min={0} max={65535} value={port || ""} placeholder={String(defaultRdPort(protocol))}
            onChange={(e) => setPort(Number(e.target.value))} onKeyDown={submitOnEnter} aria-label={t("埠")} />
        </Field>
      </div>
      {filled && <div className={`text-xs ${filled.ok ? "text-success" : "text-warning"}`} data-rd-filled="">{filled.text}</div>}
      {!isRd && (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
          <Field label={t("使用者")} className="flex-[2] min-w-[10rem]" hint={userHint}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} aria-label={t("使用者")} />
          </Field>
          {protocol === "rdp" && (
            <Field label={t("網域")} className="flex-1 min-w-[8rem]">
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} onKeyDown={submitOnEnter} aria-label={t("網域")} placeholder={t("選填")} />
            </Field>
          )}
        </div>
      )}
      <Field label={isRd ? t("RustDesk 密碼") : t("密碼")}>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={submitOnEnter}
          placeholder={editing && hasStoredPassword ? t("已儲存，留空則不變更") : t("留空＝連線時詢問")} />
      </Field>
      <Checkbox checked={remember} onChange={setRemember} label={t("記住密碼")} hint={t("存進系統鑰匙圈，不寫入設定檔")} />
      {!isRd && (
        <Field label={t("經 SSH 主機連線")}
          hint={sshSessions.length || viaSsh
            ? t("先連上這台 SSH 主機，再經它轉接到遠端桌面（內網主機、或 VNC 這種未加密的協定建議用）")
            : t("還沒有 SSH 主機：先新增一台，這裡就能選它當跳板")}>
          <Select value={viaSsh} onChange={(e) => setViaSsh(e.target.value)} disabled={!sshSessions.length && !viaSsh} aria-label={t("經 SSH 主機連線")}>
            <option value="">{t("直連")}</option>
            {sshSessions.map((s) => <option key={s.id} value={s.id}>{sessionLabel(s)}{s.name ? `（${s.username}@${s.host}）` : ""}</option>)}
            {viaSsh && !sshSessions.some((s) => s.id === viaSsh) && <option value={viaSsh}>{t("（已刪除的主機）")}</option>}
          </Select>
        </Field>
      )}

      <div className="border-t border-fg/10 pt-2">
        <button type="button" onClick={() => setAdvOpen((v) => !v)} aria-expanded={advOpen}
          className="flex items-center gap-1 text-xs font-medium text-fg/50 hover:text-fg/80">
          <Icon icon={advOpen ? ChevronDown : ChevronRight} size={13} />
          {t("進階設定（畫面、安全性）")}
        </button>
      </div>
      {advOpen && (
        <>
          <Section title={t("畫面")}>
            <Field label={t("畫面大小")}>
              <Segmented
                full
                ariaLabel={t("畫面大小")}
                value={resizeMode}
                onChange={setResizeMode}
                options={[
                  { value: "scale", label: t("縮放到分頁大小") },
                  { value: "remote", label: t("遠端跟著調整解析度") },
                  { value: "none", label: t("原始大小（捲動）") },
                ]}
              />
            </Field>
            {protocol === "rdp" && (
              <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
                <Field label={t("色深")} className="w-32">
                  <Select value={String(colorDepth)} onChange={(e) => setColorDepth(Number(e.target.value))}>
                    <option value="32">32 bit</option>
                    <option value="24">24 bit</option>
                    <option value="16">16 bit</option>
                  </Select>
                </Field>
                <Field label={t("固定解析度")} className="flex-1 min-w-[14rem]" hint={t("留空＝跟分頁大小")}>
                  <div className="flex items-center gap-1.5">
                    <Input type="number" min={0} value={width || ""} onChange={(e) => setWidth(Number(e.target.value))} placeholder="1920" aria-label={t("寬")} />
                    <span className="text-fg/40">×</span>
                    <Input type="number" min={0} value={height || ""} onChange={(e) => setHeight(Number(e.target.value))} placeholder="1080" aria-label={t("高")} />
                  </div>
                </Field>
              </div>
            )}
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <Checkbox checked={fullscreen} onChange={setFullscreen} label={t("連線後直接全螢幕")} />
              <Checkbox checked={viewOnly} onChange={setViewOnly} label={t("只看不控制")} />
              <Checkbox checked={clipboard} onChange={setClipboard} label={t("同步剪貼簿")} />
            </div>
          </Section>
          {protocol === "rdp" && (
            <Section title={t("安全性")}>
              <Checkbox checked={nla} onChange={setNla} label={t("網路層級驗證（NLA）")}
                hint={t("登入失敗時可關閉試試（改走伺服器的登入畫面）")} />
            </Section>
          )}
          {protocol === "vnc" && (
            <Section title={t("安全性")}>
              <Field label={t("認證方式")} hint={t("自動：有帳號時優先用 macOS 的 Apple 認證（ARD），否則 VNC 密碼")}>
                <Select value={vncSecurity} onChange={(e) => setVncSecurity(e.target.value as VncSecurity)}>
                  <option value="auto">{t("自動")}</option>
                  <option value="ard">{t("Apple 螢幕共享（帳號 + 密碼）")}</option>
                  <option value="vnc">{t("VNC 密碼")}</option>
                  <option value="plain">{t("VeNCrypt 帳號 + 密碼")}</option>
                  <option value="none">{t("不需認證")}</option>
                </Select>
              </Field>
              <Checkbox checked={vncShared} onChange={setVncShared} label={t("共享連線（不踢掉其他正在看的人）")} />
            </Section>
          )}
          {isRd && (
            <Section title="RustDesk">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-3">
                <Field label={t("ID / 中繼伺服器")} className="flex-1 min-w-[14rem]" hint={t("留空＝RustDesk 公開伺服器；自架的填 hbbs 位址")}>
                  <Input value={rdServer} onChange={(e) => setRdServer(e.target.value)} placeholder="rustdesk.example.com" />
                </Field>
                <Field label={t("伺服器公鑰")} className="flex-1 min-w-[14rem]">
                  <Input value={rdKey} onChange={(e) => setRdKey(e.target.value)} className="mono" />
                </Field>
              </div>
              <Checkbox checked={rdRelay} onChange={setRdRelay} label={t("強制走中繼伺服器")} />
            </Section>
          )}
        </>
      )}
    </Modal>
  );
}

function Checkbox({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      {hint && <span className="text-xs text-fg/40">{hint}</span>}
    </label>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="border-t border-fg/10 pt-3 space-y-2.5">
      {title && <div className="text-xs font-medium text-fg/50">{title}</div>}
      {children}
    </div>
  );
}
