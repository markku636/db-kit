import { useEffect, useState } from "react";
import { FileJson, X } from "lucide-react";
import { api } from "./api";
import { useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

// Elasticsearch / OpenSearch 索引 Mapping 檢視器（唯讀 overlay，仿 KafkaSchemaViewer 檢視外殼）：
// 載入 es_mapping 的原始 pretty JSON，格式化後以唯讀 <pre> 呈現。
export default function EsMappingViewer({ connId, index, connName, onClose }: {
  connId: string; index: string; connName?: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [mapping, setMapping] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    api.esMapping(connId, index)
      .then((s) => { if (alive) setMapping(s); })
      .catch((e) => { if (alive) setErr(e?.message ?? String(e)); });
    return () => { alive = false; };
  }, [connId, index]);

  const pretty = (s: string): string => {
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[760px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={FileJson} size={14} className="text-emerald-300/80" />
          <span className="font-medium text-sm">Mapping · {index}</span>
          {connName && <span className="text-xs text-fg/35">{connName}</span>}
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>

        {err && <div className="px-4 py-1.5 text-red-400 text-xs mono break-all border-b border-fg/10">{err}</div>}

        <div className="flex-1 min-h-0 overflow-auto p-3 text-xs">
          {mapping != null ? (
            <pre className="bg-inset rounded p-3 mono whitespace-pre-wrap break-all">{pretty(mapping)}</pre>
          ) : (!err && <div className="text-fg/30">{t("載入中…")}</div>)}
        </div>
      </div>
    </div>
  );
}
