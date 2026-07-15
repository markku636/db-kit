import { useEffect, useMemo, useState } from "react";
import { FileJson, X } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { json as jsonLang } from "@codemirror/lang-json";
import {
  api,
  type KafkaCompatibility,
  type KafkaSchema,
  type KafkaSchemaSubject,
} from "./api";
import { toast, uiConfirm, useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import { diffLines } from "./diff";
import { useT } from "./i18n";

const COMPAT_LEVELS = ["BACKWARD", "BACKWARD_TRANSITIVE", "FORWARD", "FORWARD_TRANSITIVE", "FULL", "FULL_TRANSITIVE", "NONE"];

// Schema Registry 檢視器（側欄 overlay）：subjects → 版本 → schema；相容性 / 版本比對 / 註冊 / 刪除。
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
  const [compat, setCompat] = useState<KafkaCompatibility | null>(null);
  const [mode, setMode] = useState<"view" | "diff" | "new">("view");
  const [diffVer, setDiffVer] = useState<number>(0);
  const [diffSchema, setDiffSchema] = useState<KafkaSchema | null>(null);
  const [draft, setDraft] = useState("");

  const loadSubjects = () =>
    api.kafkaSchemaSubjects(connId).then(setSubjects).catch((e) => setErr(e?.message ?? String(e)));
  useEffect(() => { loadSubjects(); }, [connId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selected) { setSchema(null); setCompat(null); return; }
    setErr(null);
    setMode("view");
    api.kafkaSchema(connId, selected, version).then(setSchema).catch((e) => setErr(e?.message ?? String(e)));
    api.kafkaSchemaCompatGet(connId, selected).then(setCompat).catch(() => setCompat(null));
  }, [connId, selected, version]);

  useEffect(() => {
    if (mode !== "diff" || !selected || !diffVer) { setDiffSchema(null); return; }
    api.kafkaSchema(connId, selected, diffVer).then(setDiffSchema).catch(() => {});
  }, [connId, selected, diffVer, mode]);

  const cur = subjects.find((s) => s.subject === selected);

  const prettySchema = (s: string): string => {
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
  };

  const diff = useMemo(() => {
    if (!schema || !diffSchema) return [];
    return diffLines(prettySchema(diffSchema.schema), prettySchema(schema.schema));
  }, [schema, diffSchema]);

  const setCompatLevel = async (level: string) => {
    if (!selected) return;
    try {
      await api.kafkaSchemaCompatSet(connId, selected, level);
      setCompat({ level, inherited: false });
      toast.success(t("已設定相容性為 {level}", { level }));
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  const registerDraft = async () => {
    if (!selected || !schema) return;
    try {
      const check = await api.kafkaSchemaCompatCheck(connId, selected, draft, schema.schema_type);
      if (!check.compatible) {
        toast.error(t("不相容：{msg}", { msg: check.messages.join("; ") || t("與現有 schema 不相容") }));
        return;
      }
      const newId = await api.kafkaSchemaRegister(connId, selected, draft, schema.schema_type);
      toast.success(t("已註冊新版本（schema id {id}）", { id: newId }));
      setMode("view");
      setVersion(0);
      loadSubjects();
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  const delVersion = async () => {
    if (!selected || !schema) return;
    if (!(await uiConfirm(t("軟刪除 {subject} v{version}？", { subject: selected, version: schema.version }), { danger: true }))) return;
    try {
      await api.kafkaSchemaDeleteVersion(connId, selected, schema.version);
      toast.success(t("已刪除版本"));
      setVersion(0);
      loadSubjects();
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  const delSubject = async () => {
    if (!selected) return;
    if (!(await uiConfirm(t("軟刪除整個 subject「{subject}」？", { subject: selected }), { danger: true }))) return;
    try {
      await api.kafkaSchemaDeleteSubject(connId, selected);
      toast.success(t("已刪除 subject"));
      setSelected(null);
      loadSubjects();
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[900px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
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
                <div className="flex flex-wrap items-center gap-2 text-fg/60">
                  <span className="font-medium">{schema.subject}</span>
                  <select value={version || schema.version} onChange={(e) => setVersion(Number(e.target.value))} className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent">
                    {(cur?.versions ?? [schema.version]).map((v) => <option key={v} value={v}>v{v}</option>)}
                  </select>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-fg/10 text-fg/50">{schema.schema_type}</span>
                  <span className="text-fg/30">id {schema.id}</span>
                  {compat && (
                    <label className="flex items-center gap-1 ml-2">
                      <span className="text-fg/40">{t("相容性")}</span>
                      <select value={compat.level} onChange={(e) => setCompatLevel(e.target.value)} className="bg-inset border border-fg/10 rounded px-1.5 py-1 outline-none focus:border-accent">
                        {COMPAT_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                      {compat.inherited && <span className="text-[10px] text-fg/30">{t("繼承全域")}</span>}
                    </label>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setMode("view")} className={`px-2 py-1 rounded ${mode === "view" ? "bg-accent/20 text-accent" : "text-fg/50 hover:bg-fg/10"}`}>{t("檢視")}</button>
                  <button type="button" onClick={() => { setMode("diff"); setDiffVer((cur?.versions ?? []).find((v) => v !== schema.version) ?? schema.version); }} className={`px-2 py-1 rounded ${mode === "diff" ? "bg-accent/20 text-accent" : "text-fg/50 hover:bg-fg/10"}`}>{t("版本比對")}</button>
                  <button type="button" onClick={() => { setMode("new"); setDraft(prettySchema(schema.schema)); }} className={`px-2 py-1 rounded ${mode === "new" ? "bg-accent/20 text-accent" : "text-fg/50 hover:bg-fg/10"}`}>{t("新版本")}</button>
                  <span className="ml-auto space-x-2">
                    <button type="button" onClick={delVersion} className="text-fg/40 hover:text-red-400">{t("刪除版本")}</button>
                    <button type="button" onClick={delSubject} className="text-fg/40 hover:text-red-400">{t("刪除 subject")}</button>
                  </span>
                </div>

                {mode === "view" && (
                  <pre className="bg-inset rounded p-3 mono whitespace-pre-wrap break-all">{prettySchema(schema.schema)}</pre>
                )}

                {mode === "diff" && (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="text-fg/40">{t("比對版本")}</span>
                      <select value={diffVer} onChange={(e) => setDiffVer(Number(e.target.value))} className="bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent">
                        {(cur?.versions ?? []).map((v) => <option key={v} value={v}>v{v}</option>)}
                      </select>
                      <span className="text-fg/30">→ v{schema.version}</span>
                    </div>
                    <pre className="bg-inset rounded p-3 mono whitespace-pre-wrap break-all leading-tight">
                      {diff.map((l, i) => (
                        <div key={i} className={l.type === "add" ? "bg-emerald-500/10 text-emerald-300/90" : l.type === "del" ? "bg-red-500/10 text-red-300/90" : "text-fg/60"}>
                          {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}{l.text}
                        </div>
                      ))}
                    </pre>
                  </>
                )}

                {mode === "new" && (
                  <div className="space-y-2">
                    <div className="border border-fg/15 rounded overflow-hidden">
                      <CodeMirror value={draft} onChange={setDraft} extensions={[jsonLang()]} theme="dark" height="260px" basicSetup={{ foldGutter: false }} />
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={registerDraft} className="px-3 py-1 rounded bg-accent/80 hover:bg-accent text-white">{t("檢查相容性並註冊")}</button>
                      <span className="text-fg/30">{t("以 {type} 格式撰寫；註冊前會先檢查相容性", { type: schema.schema_type })}</span>
                    </div>
                  </div>
                )}
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
