import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { api, DbKind } from "./api";
import { toast } from "./ui";
import { Modal, Button } from "./ui/index";
import { viewDefinitionSql, buildReplaceView, formatSql } from "./sql";
import SqlEditor from "./SqlEditor";
import { useSqlSchema } from "./useSqlSchema";

// 設計檢視（對標 Navicat「設計檢視」）：載入既有視圖的 SELECT 定義，編輯後以 CREATE OR REPLACE VIEW 套用。
// MySQL 透過 information_schema.VIEWS（僅 SELECT，免解析）；PostgreSQL 透過 pg_get_viewdef。
export default function ViewDesigner({ connId, db, view, kind, onClose, onSaved }: {
  connId: string;
  db: string;
  view: string;
  kind: DbKind;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [select, setSelect] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const schema = useSqlSchema(connId, kind, db); // 表 / 欄自動完成（與新增視圖 / 主編輯器一致）

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = await api.runQuery(connId, viewDefinitionSql(kind, db, view));
        const def = r.rows[0]?.[0] ?? "";
        if (alive) setSelect(def);
      } catch (e: any) {
        if (alive) setErr(e?.message ?? "載入視圖定義失敗");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [connId, db, view, kind]);

  const save = async () => {
    if (busy) return; // 與 CreateView/CreateTable 一致的再進入守衛
    if (!select.trim()) { toast.error("SELECT 定義不可為空"); return; }
    setBusy(true);
    try {
      await api.execDdl(connId, buildReplaceView(kind, db, view, select));
      toast.success(`視圖 ${view} 已更新`);
      onSaved?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "更新視圖失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      icon={Eye}
      title={(
        <span className="flex items-center gap-2">
          <span>設計檢視：{db}.{view}</span>
          <button type="button" onClick={() => setSelect((s) => formatSql(s))} disabled={loading || busy}
            className="text-xs text-fg/60 hover:text-fg disabled:opacity-40">格式化</button>
        </span>
      )}
      size="lg"
      zClass="z-[95]"
      className="!w-[820px] max-w-[96vw] h-[76vh]"
      bodyClassName="p-0 flex flex-col min-h-0 overflow-hidden"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} disabled={loading || busy} onClick={save}>儲存</Button>
        </>
      )}
    >
      <div className="px-5 py-2 text-xs text-fg/40 border-b border-fg/10">
        編輯下方 SELECT 後按「儲存」，將以 CREATE OR REPLACE VIEW 套用。
      </div>
      <div className="flex-1 overflow-hidden p-3">
        {loading ? (
          <div className="text-fg/40 text-sm p-2">載入中…</div>
        ) : err ? (
          <div className="text-red-300 text-sm p-2 mono whitespace-pre-wrap">{err}</div>
        ) : (
          <div className="w-full h-full min-h-[240px] bg-inset border border-fg/10 rounded overflow-hidden focus-within:border-accent/60">
            <SqlEditor value={select} onChange={setSelect} kind={kind} schema={schema} autoFocus placeholder="SELECT ..." />
          </div>
        )}
      </div>
    </Modal>
  );
}
