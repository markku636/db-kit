import { useState } from "react";
import { ArrowRight, GitCompareArrows } from "lucide-react";
import type { DbKind } from "./api";
import { useStore } from "./store";
import { Button, Icon, Modal } from "./ui/index";
import type { CompareTarget } from "./compareModel";
import CompareTargetPicker from "./CompareTargetPicker";
import TableCompareView from "./TableCompareView";
import { useT } from "./i18n";

/**
 * 單表結構比對：把「這張表」拿去跟另一個資料庫（可跨連線）或一份結構快照比。
 * 只比結構——欄位 / 索引 / 外鍵 / 定義；資料列比對請用 CLI 的 `dbk compare data`。
 */
export default function TableCompareDialog({ connId, kind, database, table, onClose, onUse }: {
  connId: string;
  kind: DbKind;
  database: string;
  table: string;
  onClose: () => void;
  onUse: (sql: string, targetConnId: string) => void;
}) {
  const t = useT();
  const connections = useStore((s) => s.connections);
  const srcName = connections.find((c) => c.id === connId)?.name ?? connId;
  const [target, setTarget] = useState<CompareTarget>({ mode: "live", connId, db: "", table: undefined });
  // 按「比對」才把目標定案：之後切換下拉不會讓已經跑出來的結果被抽換掉。
  const [committed, setCommitted] = useState<{ target: CompareTarget; key: number } | null>(null);

  const dstTable = target.mode === "live" ? target.table ?? table : table;
  const sameTable = target.mode === "live" && target.connId === connId && target.db === database && dstTable === table;
  const ready = (target.mode === "live" ? !!target.db && !!target.table : !!target.schema) && !sameTable;
  const dstName = target.mode === "live" ? connections.find((c) => c.id === target.connId)?.name ?? "" : "";
  const dstLabel = target.mode === "live"
    ? `${dstName} · ${target.db}`
    : target.schema ? t("快照 · {db}", { db: target.schema.database }) : t("快照");

  return (
    <Modal
      onClose={onClose}
      codeZoom
      title={<>{t("結構比對 ·")} <span className="mono text-fg/60">{table}</span></>}
      icon={GitCompareArrows}
      size="xl"
      zClass="z-50"
      className="h-[82vh]"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={<Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="mono text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 truncate">{srcName} · {database} · {table}</span>
        <Icon icon={ArrowRight} size={14} className="text-fg/30 shrink-0" />
        <span className="text-xs text-fg/40 shrink-0">{t("比對目標")}</span>
      </div>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <CompareTargetPicker srcConnId={connId} srcKind={kind} srcDb={database} srcTable={table} withTable allowSnapshot
            value={target} onChange={setTarget} />
        </div>
        <Button variant="primary" icon={GitCompareArrows} disabled={!ready}
          onClick={() => setCommitted({ target, key: (committed?.key ?? 0) + 1 })}>{t("比對")}</Button>
      </div>
      {sameTable && <div className="text-xs text-red-400">{t("來源與目標是同一張表，請改選其他連線 / 資料庫 / 資料表。")}</div>}
      {committed ? (
        <TableCompareView key={committed.key} srcConnId={connId} srcDb={database} srcTable={table} target={committed.target}
          dstTable={dstTable} srcLabel={`${srcName} · ${database}`} dstLabel={dstLabel} onUse={onUse} autoRun />
      ) : (
        <div className="text-xs text-fg/40">
          {t("選擇目標後按「比對」。目標可以是另一條連線、同連線的其他資料庫，或一份結構快照檔；差異以來源為基準（讓目標變成來源）。")}
        </div>
      )}
    </Modal>
  );
}
