import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import { api } from "./api";
import { toast } from "./ui";
import { Modal, Button } from "./ui/index";
import { databaseOptionsSql, buildAlterDatabaseCharset } from "./sql";

const CHARSETS = ["utf8mb4", "utf8", "latin1", "ascii", "big5", "gbk", "gb2312", "utf16"];

// 資料庫屬性（MySQL）：檢視 / 變更預設字元集與定序（ALTER DATABASE，僅影響日後新表）。
export default function DatabaseProperties({ connId, db, onClose }: {
  connId: string;
  db: string;
  onClose: () => void;
}) {
  const [charset, setCharset] = useState("utf8mb4");
  const [collation, setCollation] = useState("");
  const [curr, setCurr] = useState<{ charset: string; collation: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.runQuery(connId, databaseOptionsSql(db)).then((r) => {
      if (r.rows.length === 0) return;
      const [cs, coll] = r.rows[0];
      setCurr({ charset: cs ?? "", collation: coll ?? "" });
      if (cs) setCharset(cs);
      setCollation(coll ?? "");
    }).catch((e) => toast.error(e?.message ?? "讀取資料庫屬性失敗"));
  };
  useEffect(load, [connId, db]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async () => {
    setBusy(true);
    try {
      await api.execDdl(connId, buildAlterDatabaseCharset(db, charset, collation));
      toast.success("資料庫屬性已更新");
      load();
    } catch (e: any) {
      toast.error(e?.message ?? "更新失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      icon={Database}
      title={<span className="flex items-center gap-2"><span className="font-medium text-sm">資料庫屬性</span><span className="text-xs text-fg/40 mono">{db}</span></span>}
      size="md"
      zClass="z-[95]"
      bodyClassName="p-5 space-y-3 text-sm overflow-auto"
      footer={<>
        <Button variant="secondary" onClick={onClose}>關閉</Button>
        <Button variant="primary" loading={busy} onClick={apply} disabled={busy || !curr}>套用</Button>
      </>}
    >
      <div className="text-fg/40 text-xs">
        目前：{curr ? `${curr.charset} / ${curr.collation}` : "讀取中…"}　·　變更僅影響日後新表（不轉換既有資料）。
      </div>
      <div className="flex items-center gap-3">
        <span className="text-fg/45 w-20 shrink-0 text-xs">字元集</span>
        <select value={charset} onChange={(e) => setCharset(e.target.value)} title="字元集" aria-label="字元集"
          className="bg-well border border-fg/15 rounded px-2 py-1 text-xs focus:border-accent min-w-[140px]">
          {charset && !CHARSETS.includes(charset) && <option value={charset}>{charset}</option>}
          {CHARSETS.map((cs) => (<option key={cs} value={cs}>{cs}</option>))}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-fg/45 w-20 shrink-0 text-xs">定序</span>
        <input value={collation} onChange={(e) => setCollation(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))}
          title="定序（可留空用預設）"
          className="bg-well border border-fg/15 rounded px-2 py-1 text-xs focus:border-accent w-52 mono" placeholder="定序（預設）" />
      </div>
    </Modal>
  );
}
