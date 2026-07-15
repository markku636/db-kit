import { useEffect, useState } from "react";
import { FileJson, X } from "lucide-react";
import { api, type KafkaSchema, type KafkaSchemaSubject } from "./api";
import { useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

// Schema Registry 檢視器（側欄 overlay）：subjects → 版本 → schema。
export default function KafkaSchemaViewer({ connId, connName, initialSubject, onClose }: {
  connId: string; connName: string; initialSubject?: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [subjects, setSubjects] = useState<KafkaSchemaSubject[]>([]);
  const [selected, setSelected] = useState<string | null>(initialSubject ?? null);
  const [version, setVersion] = useState<number>(0);
  const [schema, setSchema] = useState<KafkaSchema | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.kafkaSchemaSubjects(connId).then(setSubjects).catch((e) => setErr(e?.message ?? String(e)));
  }, [connId]);

  useEffect(() => {
    if (!selected) { setSchema(null); return; }
    setErr(null);
    api.kafkaSchema(connId, selected, version).then(setSchema).catch((e) => setErr(e?.message ?? String(e)));
  }, [connId, selected, version]);

  const cur = subjects.find((s) => s.subject === selected);

  const prettySchema = (s: string): string => {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return s;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[840px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={FileJson} size={14} className="text-emerald-300/80" />
          <span className="font-medium text-sm">Schema Registry · {connName}</span>
          <span className="text-xs text-fg/35">{subjects.length} subjects</span>
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>

        {err && <div className="px-4 py-1.5 text-red-400 text-xs mono break-all border-b border-fg/10">{err}</div>}

        <div className="flex-1 min-h-0 flex text-xs">
          <div className="w-64 border-r border-fg/10 overflow-auto">
            {subjects.map((s) => (
              <button
                key={s.subject}
                onClick={() => { setSelected(s.subject); setVersion(0); }}
                className={`w-full text-left px-3 py-2 border-b border-fg/5 hover:bg-fg/5 ${selected === s.subject ? "bg-accent/10" : ""}`}
              >
                <div className="truncate" title={s.subject}>{s.subject}</div>
                <div className="text-fg/35">v{s.latest} · {s.versions.length} {t("版本")}</div>
              </button>
            ))}
            {subjects.length === 0 && <div className="px-3 py-4 text-fg/30">{t("無 subjects")}</div>}
          </div>

          <div className="flex-1 min-w-0 overflow-auto p-3">
            {schema ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-fg/60">
                  <span>{schema.subject}</span>
                  <select
                    value={version || schema.version}
                    onChange={(e) => setVersion(Number(e.target.value))}
                    className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent"
                  >
                    {(cur?.versions ?? [schema.version]).map((v) => (
                      <option key={v} value={v}>v{v}</option>
                    ))}
                  </select>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-fg/10 text-fg/50">{schema.schema_type}</span>
                  <span className="text-fg/30">id {schema.id}</span>
                </div>
                <pre className="bg-inset rounded p-3 mono whitespace-pre-wrap break-all">{prettySchema(schema.schema)}</pre>
              </div>
            ) : (
              <div className="text-fg/30">{t("左側選一個 subject。")}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
