import { useEffect, useState } from "react";
import { Button, Field, Input, Modal } from "./ui/index";
import { useT } from "./i18n";
import { useTenon, tenonSession } from "./tenon";
import { useStore } from "./store";

export function TenonSettings() {
  const t = useT();
  const { status, save, login, logout, busy, error, loaded } = useTenon();
  const [url, setUrl] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [auto, setAuto] = useState(false);
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  useEffect(() => { setUrl(status.config.url); setEnabled(status.config.enabled); setAuto(status.config.auto_sync); }, [status.config]);
  const close = () => { setOpen(false); setUsername(""); setPassword(""); setCode(""); };
  useEffect(() => { if (status.signed_in) close(); }, [status.signed_in]);
  return <div className="space-y-3" data-testid="tenon-settings">
    <div className="text-sm font-semibold">{t("Tenon 裝置目錄")}</div>
    <p className="text-xs text-fg/50">{t("預設關閉。請手動輸入你獲授權的服務網址；不提供預設伺服器或試用帳號。")}</p>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={enabled} disabled={busy || !loaded} onChange={e => setEnabled(e.target.checked)} />{t("啟用 Tenon 整合")}</label>
    {enabled && <>
      <Field label={t("服務網址")}><Input aria-label={t("Tenon 服務網址")} value={url} onChange={e => setUrl(e.target.value)} autoComplete="off" disabled={busy} /></Field>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={auto} disabled={busy} onChange={e => setAuto(e.target.checked)} />{t("每分鐘自動同步目錄")}</label>
    </>}
    <div className="flex gap-2 flex-wrap">
      <Button variant="secondary" disabled={busy || !loaded || (enabled && !url.trim())} onClick={() => void save({ ...status.config, enabled, url, auto_sync: auto })}>{t("儲存設定")}</Button>
      {status.config.enabled && enabled && url === status.config.url && <Button variant="secondary" disabled={busy} onClick={() => status.signed_in ? void logout() : setOpen(true)}>{status.signed_in ? t("登出 Tenon") : t("登入 Tenon")}</Button>}
    </div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <Modal open={open} onClose={close} title={t("登入 Tenon")}>
      <form className="space-y-3" autoComplete="off" onSubmit={e => { e.preventDefault(); void login(username, password, code); setPassword(""); setCode(""); }}>
        <p className="text-xs text-fg/50 break-all">{status.config.url}</p>
        <Field label={t("帳號")}><Input aria-label={t("帳號")} value={username} autoComplete="off" onChange={e => setUsername(e.target.value)} required disabled={busy} /></Field>
        <Field label={t("密碼")}><Input aria-label={t("密碼")} type="password" value={password} autoComplete="new-password" onChange={e => setPassword(e.target.value)} required disabled={busy} /></Field>
        <Field label={t("兩步驟驗證碼（如有啟用）")}><Input aria-label={t("兩步驟驗證碼（如有啟用）")} value={code} inputMode="numeric" autoComplete="off" onChange={e => setCode(e.target.value)} disabled={busy} /></Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? t("登入中…") : t("登入")}</Button>
      </form>
    </Modal>
  </div>;
}

export function TenonDirectory({ q }: { q: string }) {
  const t = useT();
  const { status, devices, busy, error, load, refresh } = useTenon();
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!status.config.enabled || !status.signed_in || !status.config.auto_sync) return;
    void refresh(); const timer = setInterval(() => void refresh(), 60_000); return () => clearInterval(timer);
  }, [status.config.enabled, status.config.auto_sync, status.config.profile, status.signed_in, refresh]);
  if (!status.config.enabled) return null;
  const visible = devices.filter(d => `${d.name} ${d.id} ${d.book} ${(d.tags || []).join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  const books = [...new Set(visible.map(d => d.book_guid))];
  return <section className="border-t border-fg/10 p-3 space-y-2" aria-label={t("Tenon 裝置目錄")}>
    <div className="flex items-center justify-between"><strong className="text-xs">Tenon</strong><Button size="sm" variant="ghost" disabled={busy || !status.signed_in} onClick={() => void refresh()}>{busy ? t("同步中…") : t("重新整理")}</Button></div>
    {!status.signed_in && <p className="text-xs text-fg/50">{t("請到設定手動登入 Tenon。")}</p>}
    {error && <p role="alert" className="text-xs text-danger break-words">{error}</p>}
    {status.signed_in && !visible.length && <p className="text-xs text-fg/50">{t("尚無裝置，請重新整理或確認通訊錄權限。")}</p>}
    {books.map(book => <div key={book}><p className="text-xs text-fg/50 mb-1">{visible.find(d => d.book_guid === book)?.book}</p>
      {visible.filter(d => d.book_guid === book).map(d => <button key={d.id} className="w-full text-left rounded px-2 py-1.5 hover:bg-fg/5 disabled:opacity-50" disabled={!d.online || !d.can_connect || busy} title={d.id} onClick={() => {
        const session = tenonSession(d, status.config);
        useStore.getState().openRdTab({ target: { kind: "ad_hoc", session }, protocol: "rustdesk", title: `Tenon · ${session.name}` });
      }}><span className="block text-xs truncate">{d.name || d.id}</span><span className="text-[10px] text-fg/50">{d.online ? t("在線") : t("離線")}{!d.can_connect ? ` · ${t("僅供檢視")}` : ""}</span></button>)}
    </div>)}
  </section>;
}
