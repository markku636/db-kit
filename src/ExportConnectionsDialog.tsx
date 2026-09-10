import { useMemo, useState } from "react";
import { KeyRound, Upload } from "lucide-react";
import { api, isProdConn, KIND_META, type ConnectionConfig, type ConnExportScope, type ConnGroup } from "./api";
import { sectionize } from "./connGroups";
import { pickSaveFile, toast } from "./ui";
import { Badge, Button, Input, Modal } from "./ui/index";
import { useT } from "./i18n";

/** 匯出檔 passphrase 最低長度（與後端 conn_crypto::MIN_PASSPHRASE 一致）。 */
const MIN_PASSPHRASE = 8;

/**
 * 進階加密匯出連線：逐筆挑要匯出的連線 + 逐類挑要帶出的機密，寫成單一 .dbkitenc 密文檔。
 *
 * 兩條硬規則（都由後端 `conn_export` 落實，UI 只負責說清楚）：
 * 1. PROD 連線一律不含帳號與密碼 —— 下面的機密勾選對它無效。匯出檔可攜、可離線暴力破解，
 *    正式環境的登入資訊不該進到這種檔案。
 * 2. 路徑每次都要現選：本對話框不記上次路徑，存檔對話框也不預填檔名，
 *    避免一路按 Enter 就把上一份同名檔靜默蓋掉。
 */
export default function ExportConnectionsDialog({ connections, groups, onClose }: {
  connections: ConnectionConfig[];
  groups: ConnGroup[];
  onClose: () => void;
}) {
  const t = useT();
  // 預設全選：多數情境是整包搬機器；要縮小範圍再用下方快捷或逐筆取消。
  const [selected, setSelected] = useState<Set<string>>(() => new Set(connections.map((c) => c.id)));
  const [filter, setFilter] = useState("");
  const [includePassword, setIncludePassword] = useState(true);
  const [includeSsh, setIncludeSsh] = useState(true);
  const [includeOtp, setIncludeOtp] = useState(true);
  const [includeGroups, setIncludeGroups] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  // 側欄同一套分區，讓這裡的順序與側欄一致；篩選後空的區段不顯示（空群組在此無拖放意義）。
  const sections = useMemo(() => sectionize(connections, groups), [connections, groups]);
  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    const match = (c: ConnectionConfig) =>
      !q || c.name.toLowerCase().includes(q) || c.host.toLowerCase().includes(q) || c.kind.includes(q);
    return sections
      .map((s) => ({ ...s, conns: s.conns.filter(match) }))
      .filter((s) => s.conns.length > 0);
  }, [sections, q]);

  const chosen = useMemo(() => connections.filter((c) => selected.has(c.id)), [connections, selected]);
  const prodCount = chosen.filter(isProdConn).length;
  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = chosen.length > 0 && passphrase.length >= MIN_PASSPHRASE && confirm === passphrase;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () => setSelected(new Set(connections.map((c) => c.id)));
  const selectNone = () => setSelected(new Set());
  const selectNonProd = () => setSelected(new Set(connections.filter((c) => !isProdConn(c)).map((c) => c.id)));

  const run = async () => {
    if (busy || !ready) return;
    setBusy(true); // 涵蓋原生存檔對話框開啟期間，同時作為防重入鎖
    try {
      // 不預填 defaultPath：每次都由使用者指定完整路徑（見檔頭規則 2）。
      const picked = await pickSaveFile(undefined, [{ name: t("db-kit 加密連線"), extensions: ["dbkitenc"] }]);
      if (!picked) return; // 取消：finally 會還原 busy
      // 沒給 defaultPath 時，部分平台的存檔對話框不會依過濾器補副檔名；使用者沒打就補上，
      // 讓匯入端（同一組副檔名過濾器）看得到這份檔。
      const path = /\.[^\\/.]+$/.test(picked) ? picked : `${picked}.dbkitenc`;
      const scope: ConnExportScope = {
        ids: chosen.map((c) => c.id),
        include_password: includePassword,
        include_ssh: includeSsh,
        include_otp: includeOtp,
        include_groups: includeGroups,
      };
      const res = await api.exportConnectionsEncrypted(path, passphrase, scope);
      toast.success(
        res.redacted > 0
          ? t("已加密匯出 {n} 個連線；其中 {p} 個 PROD 連線不含帳號與密碼", { n: res.count, p: res.redacted })
          : t("已加密匯出 {n} 個連線", { n: res.count }),
      );
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("匯出失敗"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={t("進階匯出連線")}
      icon={Upload}
      size="lg"
      bodyClassName="p-5 space-y-4 overflow-auto"
      footer={<>
        <span className="mr-auto text-xs text-fg/45">
          {t("將匯出 {n} / {total} 個連線", { n: chosen.length, total: connections.length })}
          {prodCount > 0 && ` · ${t("{p} 個 PROD 不含帳密", { p: prodCount })}`}
        </span>
        <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
        <Button variant="primary" loading={busy} onClick={run} disabled={busy || !ready}>
          {t("選擇位置並匯出")}
        </Button>
      </>}
    >
      {/* 1. 挑連線 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-fg/50">{t("要匯出的連線")}</span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" onClick={selectAll}>{t("全選")}</Button>
            <Button variant="ghost" onClick={selectNone}>{t("全不選")}</Button>
            <Button variant="ghost" onClick={selectNonProd}>{t("排除 PROD")}</Button>
          </div>
        </div>
        <Input inputSize="md" value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder={t("以名稱 / 主機 / 類型篩選")} className="mb-2" />
        <div className="max-h-64 overflow-auto rounded border border-fg/10">
          {visible.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-fg/40">{t("沒有符合的連線")}</div>
          )}
          {visible.map((s) => (
            <div key={s.group?.id ?? "__ungrouped__"}>
              <div className="px-3 py-1 text-[11px] text-fg/40 bg-bar sticky top-0">
                {s.group?.name ?? t("未分組")}
              </div>
              {s.conns.map((c) => (
                <label key={c.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer select-none hover:bg-fg/5">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="truncate">{c.name}</span>
                  <span className="shrink-0 text-[11px]" style={{ color: KIND_META[c.kind].color }}>
                    {KIND_META[c.kind].label}
                  </span>
                  <span className="truncate text-xs text-fg/35 mono">{c.host}</span>
                  {isProdConn(c) && (
                    <span className="ml-auto shrink-0 flex items-center gap-1">
                      <Badge tone="danger">PROD</Badge>
                      <span className="text-[11px] text-fg/40">{t("不含帳密")}</span>
                    </span>
                  )}
                </label>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* 2. 挑機密：分類勾選，沒勾的類別後端連 keychain 都不讀。 */}
      <div>
        <span className="text-xs text-fg/50 mb-1 block">{t("要一起帶出的機密")}</span>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={includePassword} onChange={(e) => setIncludePassword(e.target.checked)} />
            {t("資料庫密碼")}
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={includeSsh} onChange={(e) => setIncludeSsh(e.target.checked)} />
            {t("SSH 密碼 / 私鑰 passphrase")}
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={includeOtp} onChange={(e) => setIncludeOtp(e.target.checked)} />
            {t("OTP secret")}
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={includeGroups} onChange={(e) => setIncludeGroups(e.target.checked)} />
            {t("側欄群組歸屬")}
          </label>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-danger/85">
          {t("PROD 連線一律不含帳號與密碼（含 SSH / OTP），上面的勾選對它無效；匯入端要自己補登入資訊。")}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-fg/40">
          {t("沒帶出的機密以空值寫入：匯入端若已有同一筆連線，既有的密碼不會被覆寫。")}
        </p>
      </div>

      {/* 3. 加密 passphrase */}
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-fg/50 mb-1 block">{t("加密密碼（passphrase）")}</span>
          <Input inputSize="md" type="password" invalid={tooShort} value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)} placeholder={t("至少 8 碼，匯入時需輸入相同密碼")} />
          {tooShort && <span className="mt-1 block text-[11px] text-danger">{t("passphrase 至少 8 碼")}</span>}
        </label>
        <label className="block">
          <span className="text-xs text-fg/50 mb-1 block">{t("再次輸入")}</span>
          <Input inputSize="md" type="password" invalid={mismatch} value={confirm}
            onChange={(e) => setConfirm(e.target.value)} />
          {mismatch && <span className="mt-1 block text-[11px] text-danger">{t("兩次輸入不一致")}</span>}
        </label>
      </div>
      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-fg/40">
        <KeyRound size={13} className="mt-0.5 shrink-0" />
        {t("檔案以 AES-256-GCM 加密（金鑰由 Argon2id 派生）。passphrase 不會存在任何地方，忘了就解不開。")}
      </p>
    </Modal>
  );
}
