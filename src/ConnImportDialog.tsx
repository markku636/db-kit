import { useState } from "react";
import { Download, FolderOpen } from "lucide-react";
import { api, KIND_META, type ConnectionConfig } from "./api";
import { useStore } from "./store";
import { pickOpenFiles, toast } from "./ui";
import { Badge, Button, Modal } from "./ui/index";
import { mergeDataGripLocal, parseToolConnections, type ImportDraft, type ImportSource } from "./connImport";
import { useT } from "./i18n";

/**
 * 從其他工具匯入連線：選 DBeaver 的 data-sources.json、DataGrip 的 dataSources.xml（可連同 .local.xml 一起選）
 * 或 .ncx 連線檔 → 預覽清單、勾選 → 建成 db-kit 連線。只匯入位置與帳號，**不匯入密碼**。
 * 只有 JDBC URL 的項目交給後端 parse_connection_url 補出主機 / 埠 / 資料庫。
 */
export default function ConnImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const existing = useStore((s) => s.connections);
  const [drafts, setDrafts] = useState<ImportDraft[]>([]);
  const [source, setSource] = useState<ImportSource | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  const dupOf = (d: ImportDraft) =>
    existing.some((c) => c.name === d.name || (!!d.host && c.host === d.host && c.port === d.port && c.kind === d.kind && (c.database ?? "") === (d.database ?? "")));

  const pick = async () => {
    const paths = await pickOpenFiles([{ name: t("連線設定檔"), extensions: ["json", "xml", "ncx"] }]);
    if (!paths.length) return;
    try {
      let all: ImportDraft[] = [];
      let src: ImportSource | null = null;
      let localXml: string | null = null;
      for (const p of paths) {
        const text = await api.readTextFile(p);
        if (/dataSources\.local\.xml$/i.test(p)) { localXml = text; continue; }
        const r = parseToolConnections(p, text);
        src = r.source;
        all = all.concat(r.drafts);
      }
      if (localXml) all = mergeDataGripLocal(all, localXml);
      // 只有 URL 的：請後端解析（與連線對話框貼連線字串同一套）。
      all = await Promise.all(all.map(async (d) => {
        if (d.host || !d.url) return d;
        try {
          const u = await api.parseConnectionUrl(d.url, d.kind ?? undefined);
          return { ...d, kind: d.kind ?? u.kind, host: u.host ?? undefined, port: u.port ?? undefined, database: d.database ?? u.database ?? undefined, username: d.username ?? u.username ?? undefined };
        } catch {
          return d;
        }
      }));
      setDrafts(all);
      setSource(src);
      setPicked(new Set(all.map((d, i) => (d.kind && !dupOf(d) ? i : -1)).filter((i) => i >= 0)));
      if (all.length === 0) toast.info(t("檔案裡沒有連線"));
    } catch (e) {
      toast.error(t("看不懂這個檔案：請選 DBeaver 的 data-sources.json、DataGrip 的 dataSources.xml 或 .ncx 連線檔。{msg}", { msg: String((e as Error)?.message ?? "") === "unrecognized" ? "" : String((e as Error)?.message ?? e) }));
    }
  };

  const doImport = async () => {
    setBusy(true);
    let ok = 0;
    try {
      for (const i of [...picked].sort((a, b) => a - b)) {
        const d = drafts[i];
        if (!d.kind) continue;
        const cfg: ConnectionConfig = {
          id: crypto.randomUUID(),
          name: d.name,
          kind: d.kind,
          host: d.host ?? "",
          port: d.port ?? KIND_META[d.kind]?.defaultPort ?? 0,
          username: d.username ?? "",
          password: "",
          database: d.database ?? null,
          max_connections: 5,
          ssh_enabled: !!d.ssh,
          ssh_host: d.ssh?.host ?? "",
          ssh_port: d.ssh?.port ?? 22,
          ssh_username: d.ssh?.username ?? "",
          ssh_auth_method: "password",
          ssh_password: "",
          ssh_private_key_path: "",
          ssh_passphrase: "",
        };
        await api.saveConnection(cfg);
        ok++;
      }
      const saved = await api.listSavedConnections();
      useStore.getState().setConnections(saved.map((c) => ({ ...c, password: c.password ?? "" } as ConnectionConfig)));
      toast.success(t("已匯入 {n} 個連線；密碼沒有匯入，連線前請在「編輯」裡輸入。", { n: ok }));
      onClose();
    } catch (e) {
      toast.error(t("匯入失敗：{msg}", { msg: String((e as Error)?.message ?? e) }));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: number) => setPicked((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const SOURCE_LABEL: Record<ImportSource, string> = { dbeaver: "DBeaver", datagrip: "DataGrip", ncx: t(".ncx 連線檔") };

  return (
    <Modal
      onClose={onClose}
      title={t("從其他工具匯入連線")}
      icon={Download}
      size="lg"
      zClass="z-50"
      bodyClassName="p-5 space-y-3 overflow-auto max-h-[70vh]"
      footer={
        <>
          <Button variant="secondary" icon={FolderOpen} onClick={() => void pick()} data-conn-import-pick>{drafts.length ? t("重新選檔") : t("選擇檔案…")}</Button>
          <Button variant="primary" loading={busy} disabled={picked.size === 0} onClick={() => void doImport()} data-conn-import-go>
            {t("匯入 {n} 個", { n: picked.size })}
          </Button>
        </>
      }
    >
      <div className="text-xs text-fg/50">
        {t("支援 DBeaver 的 data-sources.json、DataGrip 的 dataSources.xml（帳號在 dataSources.local.xml，可一起選）與 .ncx 連線檔。只匯入主機、埠、資料庫、帳號與 SSH 通道；密碼不會匯入（各工具用自己的金鑰加密），匯入後請在連線「編輯」裡輸入。")}
      </div>
      {source && <div className="text-xs text-fg/60">{t("來源：{src} · {n} 個連線", { src: SOURCE_LABEL[source], n: drafts.length })}</div>}
      {drafts.length > 0 && (
        <table className="w-full text-xs" data-conn-import-list>
          <thead className="text-fg/40 text-left">
            <tr><th className="w-6" /><th className="py-1">{t("名稱")}</th><th>{t("種類")}</th><th>{t("位置")}</th><th>{t("帳號")}</th><th /></tr>
          </thead>
          <tbody>
            {drafts.map((d, i) => {
              const dup = dupOf(d);
              return (
                <tr key={i} className="border-t border-fg/5">
                  <td><input type="checkbox" checked={picked.has(i)} disabled={!d.kind} onChange={() => toggle(i)} /></td>
                  <td className="py-1 pr-2 truncate max-w-[12rem]" title={d.folder ? `${d.folder} / ${d.name}` : d.name}>{d.name}</td>
                  <td className="pr-2">{d.kind ? KIND_META[d.kind]?.label ?? d.kind : <span className="text-red-300/80">{t("不支援")}</span>}</td>
                  <td className="pr-2 mono truncate max-w-[16rem]" title={d.url ?? ""}>
                    {d.kind === "sqlite" ? d.database : [d.host, d.port].filter(Boolean).join(":")}{d.kind !== "sqlite" && d.database ? ` / ${d.database}` : ""}
                    {d.ssh && <span className="text-fg/40"> · SSH {d.ssh.host}</span>}
                  </td>
                  <td className="pr-2 mono">{d.username ?? ""}</td>
                  <td>{dup && <Badge tone="warning">{t("可能已存在")}</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
