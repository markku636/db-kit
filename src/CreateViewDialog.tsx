import { useMemo, useState } from "react";
import { Eye } from "lucide-react";
import { api, DbKind } from "./api";
import { buildCreateView } from "./sql";
import { toast } from "./ui";
import { Modal, Button } from "./ui/index";
import SqlEditor from "./SqlEditor";
import { useSqlSchema } from "./useSqlSchema";
import { useT } from "./i18n";

// 新增視圖：輸入名稱 + SELECT → CREATE VIEW（走 exec_ddl 簡單協定，與其他 DDL 一致）。
export default function CreateViewDialog({ connId, database, kind, onClose, onCreated }: {
  connId: string;
  database: string;
  kind: DbKind;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [select, setSelect] = useState("SELECT * FROM ");
  const [busy, setBusy] = useState(false);
  const schema = useSqlSchema(connId, kind, database); // 表 / 欄自動完成（與主查詢編輯器一致）

  const valid = !!name.trim() && /\bselect\b/i.test(select);
  const previewSql = useMemo(
    () => (valid ? buildCreateView(kind, database, name, select) : "—"),
    [valid, kind, database, name, select],
  );

  const create = async () => {
    if (busy || !valid) return;
    setBusy(true);
    try {
      await api.execDdl(connId, buildCreateView(kind, database, name, select));
      toast.success(t("視圖「{trim}」已建立", { trim: name.trim() }));
      onCreated?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("建立視圖失敗"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      icon={Eye}
      title={<span className="flex items-center gap-2">{t("新增視圖")}<span className="text-xs text-fg/40 mono">{database}</span></span>}
      size="md"
      zClass="z-[95]"
      className="!w-[640px]"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={<>
        <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
        <Button variant="primary" loading={busy} onClick={create} disabled={busy || !valid}>{t("建立視圖")}</Button>
      </>}>
      <label className="block">
        <span className="text-xs text-fg/50 mb-1 block">{t("視圖名稱")}</span>
        <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)}
          placeholder={t("例：active_users")} />
      </label>
      <div className="block">
        <span className="text-xs text-fg/50 mb-1 block">{t("SELECT 查詢")}</span>
        <div className="h-40 bg-inset border border-fg/10 rounded overflow-hidden focus-within:border-accent">
          <SqlEditor value={select} onChange={setSelect} kind={kind} schema={schema} placeholder="SELECT ..." />
        </div>
      </div>
      <div>
        <span className="text-xs text-fg/40 mb-1 block">{t("SQL 預覽")}</span>
        <pre className="bg-inset border border-fg/10 rounded p-3 text-xs mono text-fg/70 overflow-auto max-h-32 whitespace-pre-wrap">{previewSql}</pre>
      </div>
    </Modal>
  );
}

const inputCls = "w-full bg-inset border border-fg/10 rounded px-2 py-1.5 text-sm mono outline-none focus:border-accent";
