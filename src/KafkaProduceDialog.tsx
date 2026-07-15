import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { api, type KafkaHeader } from "./api";
import { Modal, Button, Field, Input, Textarea } from "./ui/index";
import { toast } from "./ui";
import { useT } from "./i18n";

export interface ProduceInitial {
  key?: string | null;
  value?: string | null;
  headers?: KafkaHeader[];
  partition?: number | null;
}

// 發佈訊息對話框（仿 NewKeyDialog）。allowTopicChange 時 topic 可改（重新處理到其他主題）。
export default function KafkaProduceDialog({ connId, topic, onClose, onSent, initial, allowTopicChange }: {
  connId: string; topic: string; onClose: () => void; onSent?: () => void;
  initial?: ProduceInitial; allowTopicChange?: boolean;
}) {
  const t = useT();
  const [targetTopic, setTargetTopic] = useState(topic);
  const [topics, setTopics] = useState<string[]>([]);
  const [partition, setPartition] = useState(initial?.partition != null ? String(initial.partition) : "");
  const [key, setKey] = useState(initial?.key ?? "");
  const [value, setValue] = useState(initial?.value ?? "");
  const [headers, setHeaders] = useState<KafkaHeader[]>(initial?.headers ?? []);
  const [valueFormat, setValueFormat] = useState<"raw" | "avro">("raw");
  const [subjects, setSubjects] = useState<string[]>([]);
  const [subject, setSubject] = useState(`${topic}-value`);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!allowTopicChange) return;
    api.kafkaTopics(connId).then((ts) => setTopics(ts.map((x) => x.name).sort())).catch(() => {});
  }, [connId, allowTopicChange]);

  useEffect(() => {
    if (valueFormat !== "avro") return;
    api.kafkaSchemaSubjects(connId).then((ss) => setSubjects(ss.map((s) => s.subject).sort())).catch(() => {});
  }, [connId, valueFormat]);

  // 目標主題變更時，預設 subject 跟著猜 "{topic}-value"（未手動改過才跟）。
  useEffect(() => { setSubject(`${targetTopic}-value`); }, [targetTopic]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.kafkaProduce(connId, {
        topic: targetTopic,
        partition: partition.trim() === "" ? null : Number(partition),
        key: key === "" ? null : key,
        value: value === "" ? null : value,
        headers: headers.filter((h) => h.key.trim()),
        value_format: valueFormat,
        value_subject: valueFormat === "avro" ? subject : null,
      });
      toast.success(t("已送出 → partition {p} / offset {o}", { p: res.partition, o: res.offset }));
      onSent?.();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("發佈失敗"));
    } finally {
      setBusy(false);
    }
  };

  const prettify = () => {
    try {
      setValue(JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      /* 非 JSON，忽略 */
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={`${t("發佈訊息")} · ${targetTopic}`}
      icon={Send}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>{t("送出")}</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {allowTopicChange && (
          <Field label={t("目標主題")}>
            <select
              value={targetTopic}
              onChange={(e) => setTargetTopic(e.target.value)}
              className="w-full bg-inset border border-fg/10 rounded px-2 py-1.5 outline-none focus:border-accent"
            >
              {!topics.includes(targetTopic) && <option value={targetTopic}>{targetTopic}</option>}
              {topics.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
            </select>
          </Field>
        )}
        <div className="flex gap-3">
          <Field label={t("分區（空白＝自動）")} className="w-40">
            <Input value={partition} onChange={(e) => setPartition(e.target.value)} placeholder={t("自動")} />
          </Field>
          <Field label="Key" className="flex-1">
            <Input value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-fg/40 text-xs">{t("值格式")}</span>
          <div className="inline-flex rounded border border-fg/15 overflow-hidden text-xs">
            <button type="button" onClick={() => setValueFormat("raw")} className={`px-2 py-1 ${valueFormat === "raw" ? "bg-accent/20 text-accent" : "text-fg/50 hover:bg-fg/10"}`}>{t("原文")}</button>
            <button type="button" onClick={() => setValueFormat("avro")} className={`px-2 py-1 ${valueFormat === "avro" ? "bg-accent/20 text-accent" : "text-fg/50 hover:bg-fg/10"}`}>{t("Avro（Schema Registry）")}</button>
          </div>
          {valueFormat === "avro" && (
            <select value={subject} onChange={(e) => setSubject(e.target.value)} className="bg-inset border border-fg/10 rounded px-2 py-1 text-xs outline-none focus:border-accent">
              {!subjects.includes(subject) && <option value={subject}>{subject}</option>}
              {subjects.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>
        <Field label="Value">
          <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={7} className="mono" />
        </Field>
        <div className="flex items-center gap-3">
          <button type="button" onClick={prettify} className="text-xs text-accent hover:underline">{t("JSON 美化")}</button>
          {valueFormat === "avro" && <span className="text-fg/30 text-xs">{t("以 JSON 撰寫 value，將依 subject 的 Avro schema 編碼")}</span>}
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-fg/40 text-xs">Headers</span>
            <button type="button" onClick={() => setHeaders((h) => [...h, { key: "", value: "" }])} className="text-xs text-accent hover:underline">+ {t("新增")}</button>
          </div>
          {headers.map((h, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <Input value={h.key} onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder="key" className="flex-1" />
              <Input value={h.value} onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="value" className="flex-1" />
              <button type="button" onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))} className="px-2 text-fg/40 hover:text-red-400">×</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
