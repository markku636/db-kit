import { useMemo, useState } from "react";
import { Folder, KeyRound, Upload, type LucideIcon } from "lucide-react";
import { api, isProdConn, KIND_META, type ConnectionConfig, type ConnExportScope, type ConnGroup, type DbKind } from "./api";
import { groupsOfKind } from "./connGroups";
import { kindIcon } from "./kindIcons";
import { rdEndpoint, rdProtocolLabel, rdSessionLabel, useRdSessions } from "./rdSessions";
import { RD_META } from "./rdStatus";
import { sectionize, type GroupLike } from "./sidebarGroups";
import { sessionLabel, useSshSessions } from "./sshSessions";
import { pickSaveFile, toast } from "./ui";
import { Badge, Button, Icon, Input, Modal } from "./ui/index";
import { useT } from "./i18n";

/** 匯出檔 passphrase 最低長度（與後端 conn_crypto::MIN_PASSPHRASE 一致）。 */
const MIN_PASSPHRASE = 8;

/** 清單一列：`key` = `db:` / `ssh:` / `rd:` 前綴 + id（三類的 id 各自獨立，前綴避免撞號）。 */
interface Row {
  key: string;
  name: string;
  detail: string;
  tag?: string;
  tagColor?: string;
  prod: boolean;
}
/** 區塊內的一個群組；`group === null` = 未分組（排在最後，同側欄）。 */
interface RowGroup {
  group: GroupLike | null;
  rows: Row[];
}
/** 一個區塊 = 側欄的一段：每個資料庫種類各一段，再來是 SSH 主機、遠端桌面。 */
interface Block {
  id: string;
  title: string;
  icon?: LucideIcon;
  color?: string;
  groups: RowGroup[];
}

const dbKey = (id: string) => `db:${id}`;
const sshKey = (id: string) => `ssh:${id}`;
const rdKey = (id: string) => `rd:${id}`;
const idsOf = (keys: Set<string>, prefix: string) =>
  [...keys].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));

/**
 * 進階加密匯出連線：照側欄的分段與群組（資料庫各種類 > 群組、SSH 主機 > 資料夾、遠端桌面 > 資料夾）
 * 列出全部項目，可整段 / 整個群組 / 逐筆勾選，再逐類挑要帶出的機密，寫成單一 .dbkitenc 密文檔。
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
  const sshFolders = useSshSessions((s) => s.folders);
  const sshHosts = useSshSessions((s) => s.sessions);
  const rdFolders = useRdSessions((s) => s.folders);
  const rdHosts = useRdSessions((s) => s.sessions);

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    const kinds = (Object.keys(KIND_META) as DbKind[]).filter((k) => connections.some((c) => c.kind === k));
    for (const kind of kinds) {
      const conns = connections.filter((c) => c.kind === kind);
      out.push({
        id: `db:${kind}`,
        title: KIND_META[kind].label,
        icon: kindIcon(kind),
        color: KIND_META[kind].color,
        groups: sectionize(conns, groupsOfKind(groups, kind), (c) => c.group_id).map((s) => ({
          group: s.group,
          rows: s.items.map((c) => ({ key: dbKey(c.id), name: c.name, detail: c.host, prod: isProdConn(c) })),
        })),
      });
    }
    if (sshHosts.length > 0) {
      out.push({
        id: "ssh",
        title: t("SSH 主機"),
        groups: sectionize(sshHosts, sshFolders, (s) => s.folder_id).map((s) => ({
          group: s.group,
          rows: s.items.map((h) => ({
            key: sshKey(h.id),
            name: sessionLabel(h),
            // 沒取名的主機名稱就是 user@host，不必再印一次。
            detail: h.name?.trim() ? (h.username ? `${h.username}@${h.host}` : h.host) : "",
            tag: h.protocol === "ftp" ? "FTP" : undefined,
            prod: false,
          })),
        })),
      });
    }
    if (rdHosts.length > 0) {
      out.push({
        id: "rd",
        title: t("遠端桌面"),
        groups: sectionize(rdHosts, rdFolders, (s) => s.folder_id).map((s) => ({
          group: s.group,
          rows: s.items.map((h) => ({
            key: rdKey(h.id),
            name: rdSessionLabel(h),
            detail: rdEndpoint(h),
            tag: rdProtocolLabel(h.protocol),
            tagColor: RD_META[h.protocol].color,
            prod: false,
          })),
        })),
      });
    }
    return out;
  }, [connections, groups, sshHosts, sshFolders, rdHosts, rdFolders, t]);

  const allRows = useMemo(() => blocks.flatMap((b) => b.groups.flatMap((g) => g.rows)), [blocks]);

  // 預設全選：多數情境是整包搬機器；要縮小範圍再用整段 / 群組勾選或下方快捷。
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allRows.map((r) => r.key)));
  const [filter, setFilter] = useState("");
  const [includePassword, setIncludePassword] = useState(true);
  const [includeSsh, setIncludeSsh] = useState(true);
  const [includeOtp, setIncludeOtp] = useState(true);
  const [includeRd, setIncludeRd] = useState(true);
  const [includeGroups, setIncludeGroups] = useState(true);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  // 篩選：比對名稱、主機、協定，以及區塊 / 群組名稱（打「docker」「ssh」或群組名就留下整段 / 整組）。
  // 篩選後空的群組 / 區塊不顯示；整段 / 群組的勾選只作用在看得到的那些列。
  const q = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    const has = (s: string | undefined) => !!s && s.toLowerCase().includes(q);
    return blocks
      .map((b) => ({
        ...b,
        groups: b.groups.map((g) => {
          if (!q || has(b.title) || has(g.group?.name)) return g;
          return { ...g, rows: g.rows.filter((r) => has(r.name) || has(r.detail) || has(r.tag)) };
        }),
      }))
      .map((b) => ({ ...b, groups: b.groups.filter((g) => g.rows.length > 0) }))
      .filter((b) => b.groups.length > 0);
  }, [blocks, q]);

  // 只算現在還存在的項目（對話框開著時側欄刪掉的那筆不算進去）。
  const chosen = allRows.filter((r) => selected.has(r.key));
  const prodCount = chosen.filter((r) => r.prod).length;
  const hasProd = allRows.some((r) => r.prod);
  const tooShort = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = chosen.length > 0 && passphrase.length >= MIN_PASSPHRASE && confirm === passphrase;

  const setMany = (keys: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const selectAll = () => setSelected(new Set(allRows.map((r) => r.key)));
  const selectNone = () => setSelected(new Set());
  const selectNonProd = () => setSelected(new Set(allRows.filter((r) => !r.prod).map((r) => r.key)));

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
      const keys = new Set(chosen.map((r) => r.key));
      // 三類都明確給 id 陣列（空陣列 = 這類一筆都不要；後端 None 才是「全部」）。
      const scope: ConnExportScope = {
        ids: idsOf(keys, "db:"),
        ssh_ids: idsOf(keys, "ssh:"),
        rd_ids: idsOf(keys, "rd:"),
        include_password: includePassword,
        include_ssh: includeSsh,
        include_otp: includeOtp,
        include_rd: includeRd,
        include_groups: includeGroups,
      };
      const res = await api.exportConnectionsEncrypted(path, passphrase, scope);
      const n = res.count + res.ssh + res.rd;
      toast.success(
        res.redacted > 0
          ? t("已加密匯出 {n} 個連線；其中 {p} 個 PROD 連線不含帳號與密碼", { n, p: res.redacted })
          : t("已加密匯出 {n} 個連線", { n }),
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
          {t("將匯出 {n} / {total} 個連線", { n: chosen.length, total: allRows.length })}
          {prodCount > 0 && ` · ${t("{p} 個 PROD 不含帳密", { p: prodCount })}`}
        </span>
        <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
        <Button variant="primary" loading={busy} onClick={run} disabled={busy || !ready}>
          {t("選擇位置並匯出")}
        </Button>
      </>}
    >
      {/* 1. 挑連線：分段與群組同側欄 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-fg/50">{t("要匯出的連線")}</span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" onClick={selectAll}>{t("全選")}</Button>
            <Button variant="ghost" onClick={selectNone}>{t("全不選")}</Button>
            {hasProd && <Button variant="ghost" onClick={selectNonProd}>{t("排除 PROD")}</Button>}
          </div>
        </div>
        <Input inputSize="md" value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder={t("以名稱 / 主機 / 類型篩選")} className="mb-2" />
        <div className="max-h-[min(26rem,50vh)] overflow-auto rounded border border-fg/10" data-export-list>
          {visible.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-fg/40">{t("沒有符合的連線")}</div>
          )}
          {visible.map((b) => {
            const keys = b.groups.flatMap((g) => g.rows.map((r) => r.key));
            return (
              <div key={b.id} data-export-block={b.id}>
                <label className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-bar border-b border-fg/5 text-[11px] uppercase tracking-wide text-fg/55 cursor-pointer select-none">
                  <TriCheck keys={keys} selected={selected} onSet={setMany} label={b.title} />
                  {b.icon && <Icon icon={b.icon} size={12} className="shrink-0" style={{ color: b.color }} />}
                  <span className="truncate">{b.title}</span>
                  <span className="text-fg/35 normal-case">{countLabel(keys, selected)}</span>
                </label>
                {b.groups.map((g) => g.group ? (
                  <div key={g.group.id} data-export-group={g.group.name}>
                    <label className="flex items-center gap-2 pl-7 pr-3 py-1 text-sm cursor-pointer select-none hover:bg-fg/5">
                      <TriCheck keys={g.rows.map((r) => r.key)} selected={selected} onSet={setMany} label={g.group.name} />
                      <Icon icon={Folder} size={13} className="shrink-0 text-fg/45" />
                      <span className="truncate">{g.group.name}</span>
                      <span className="shrink-0 text-[11px] text-fg/35">{countLabel(g.rows.map((r) => r.key), selected)}</span>
                    </label>
                    {g.rows.map((r) => (
                      <RowLine key={r.key} row={r} indent="pl-12" checked={selected.has(r.key)}
                        onToggle={() => setMany([r.key], !selected.has(r.key))} />
                    ))}
                  </div>
                ) : (
                  <div key="__ungrouped__">
                    {g.rows.map((r) => (
                      <RowLine key={r.key} row={r} indent="pl-7" checked={selected.has(r.key)}
                        onToggle={() => setMany([r.key], !selected.has(r.key))} />
                    ))}
                  </div>
                ))}
              </div>
            );
          })}
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
          {rdHosts.length > 0 && (
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={includeRd} onChange={(e) => setIncludeRd(e.target.checked)} />
              {t("遠端桌面密碼")}
            </label>
          )}
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={includeGroups} onChange={(e) => setIncludeGroups(e.target.checked)} />
            {t("側欄群組歸屬")}
          </label>
        </div>
        {hasProd && (
          <p className="mt-2 text-[11px] leading-relaxed text-danger/85">
            {t("PROD 連線一律不含帳號與密碼（含 SSH / OTP），上面的勾選對它無效；匯入端要自己補登入資訊。")}
          </p>
        )}
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

/** 「已選 / 總數」。 */
function countLabel(keys: string[], selected: Set<string>): string {
  return `${keys.filter((k) => selected.has(k)).length} / ${keys.length}`;
}

/** 整段 / 整個群組的勾選框：全選 = 勾、部分 = 半勾（indeterminate）、全不選 = 空；點下去在全選與全不選間切換。 */
function TriCheck({ keys, selected, onSet, label }: {
  keys: string[];
  selected: Set<string>;
  onSet: (keys: string[], on: boolean) => void;
  label: string;
}) {
  const n = keys.filter((k) => selected.has(k)).length;
  const all = n === keys.length && n > 0;
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={all}
      ref={(el) => { if (el) el.indeterminate = n > 0 && !all; }}
      onChange={() => onSet(keys, !all)}
    />
  );
}

function RowLine({ row, indent, checked, onToggle }: { row: Row; indent: string; checked: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <label className={`flex items-center gap-2 ${indent} pr-3 py-1.5 text-sm cursor-pointer select-none hover:bg-fg/5`}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="truncate">{row.name}</span>
      {row.tag && (
        <span className="shrink-0 text-[11px]" style={{ color: row.tagColor }}>{row.tag}</span>
      )}
      <span className="truncate text-xs text-fg/35 mono">{row.detail}</span>
      {row.prod && (
        <span className="ml-auto shrink-0 flex items-center gap-1">
          <Badge tone="danger">PROD</Badge>
          <span className="text-[11px] text-fg/40">{t("不含帳密")}</span>
        </span>
      )}
    </label>
  );
}
