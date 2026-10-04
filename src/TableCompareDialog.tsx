import { useState } from "react";
import { ArrowLeftRight, ArrowRight, GitCompareArrows } from "lucide-react";
import type { DbKind } from "./api";
import { useStore } from "./store";
import { Button, Icon, IconButton, Modal } from "./ui/index";
import type { CompareTarget } from "./compareModel";
import CompareTargetPicker from "./CompareTargetPicker";
import TableCompareView from "./TableCompareView";
import { useT } from "./i18n";

/**
 * 單表結構比對：把「這張表」拿去跟另一個資料庫（可跨連線）或一份結構快照比。
 * 只比結構——欄位 / 索引 / 外鍵 / 定義；資料列比對是另一個對話框（DataCompareDialog）。
 * 來源是可交換的：按錯方向不必關掉重開，按「⇄」把兩邊對調即可。
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
  const [source, setSource] = useState({ connId, db: database, table });
  const srcKind = connections.find((c) => c.id === source.connId)?.kind ?? kind;
  const srcName = connections.find((c) => c.id === source.connId)?.name ?? source.connId;
  const [target, setTarget] = useState<CompareTarget>({ mode: "live", connId, db: "", table: undefined });
  // 按「比對」才把目標定案：之後切換下拉不會讓已經跑出來的結果被抽換掉。
  const [committed, setCommitted] = useState<{ source: typeof source; target: CompareTarget; key: number } | null>(null);

  const dstTable = target.mode === "live" ? target.table ?? source.table : source.table;
  const sameTable = target.mode === "live" && target.connId === source.connId && target.db === source.db && dstTable === source.table;
  const ready = (target.mode === "live" ? !!target.db && !!target.table : !!target.schema) && !sameTable;
  const dstName = target.mode === "live" ? connections.find((c) => c.id === target.connId)?.name ?? "" : "";
  const dstLabel = target.mode === "live"
    ? `${dstName} · ${target.db}`
    : target.schema ? t("快照 · {db}", { db: target.schema.database }) : t("快照");
  const canSwap = target.mode === "live" && !!target.db && !!target.table && !sameTable;

  const swap = () => {
    if (target.mode !== "live" || !target.table) return;
    const next = { connId: target.connId, db: target.db, table: target.table };
    setTarget({ mode: "live", connId: source.connId, db: source.db, table: source.table });
    setSource(next);
    setCommitted(null);
  };

  return (
    <Modal
      onClose={onClose}
      codeZoom
      title={<>{t("結構比對 ·")} <span className="mono text-fg/60">{source.table}</span></>}
      icon={GitCompareArrows}
      size="xl"
      zClass="z-50"
      className="h-[82vh]"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={<Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="mono text-xs px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 truncate" data-compare-source>{srcName} · {source.db} · {source.table}</span>
        <IconButton icon={ArrowLeftRight} label={t("交換來源與目標")} iconSize={14} box="w-6 h-6" disabled={!canSwap} onClick={swap} />
        <Icon icon={ArrowRight} size={14} className="text-fg/30 shrink-0" />
        <span className="text-xs text-fg/40 shrink-0">{t("比對目標")}</span>
      </div>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <CompareTargetPicker srcConnId={source.connId} srcKind={srcKind} srcDb={source.db} srcTable={source.table} withTable allowSnapshot
            value={target} onChange={setTarget} />
        </div>
        <Button variant="primary" icon={GitCompareArrows} disabled={!ready}
          onClick={() => setCommitted({ source, target, key: (committed?.key ?? 0) + 1 })}>{t("比對")}</Button>
      </div>
      {sameTable && <div className="text-xs text-red-400">{t("來源與目標是同一張表，請改選其他連線 / 資料庫 / 資料表。")}</div>}
      {committed ? (
        <TableCompareView key={committed.key} srcConnId={committed.source.connId} srcDb={committed.source.db} srcTable={committed.source.table}
          target={committed.target} dstTable={committed.target.mode === "live" ? committed.target.table ?? committed.source.table : committed.source.table}
          srcLabel={`${connections.find((c) => c.id === committed.source.connId)?.name ?? committed.source.connId} · ${committed.source.db}`}
          dstLabel={dstLabel} onUse={onUse} autoRun
          onReviewRun={(sql, connId, db) => { useStore.getState().openReviewRun({ connId, database: db, sql, origin: "compare" }); onClose(); }} />
      ) : (
        <div className="text-xs text-fg/40">
          {t("選擇目標後按「比對」。目標可以是另一條連線、同連線的其他資料庫，或一份結構快照檔；差異以來源為基準（讓目標變成來源）。按「⇄」可把來源與目標對調。")}
        </div>
      )}
    </Modal>
  );
}
