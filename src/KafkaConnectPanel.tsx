import { useEffect, useState } from "react";
import { Cable, X } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { json as jsonLang } from "@codemirror/lang-json";
import {
  api,
  type KafkaConnector,
  type KafkaConnectPlugin,
} from "./api";
import { toast, uiConfirm, useModalOverlay } from "./ui";
import { IconButton } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

const STATE_CLS: Record<string, string> = {
  RUNNING: "bg-emerald-500/15 text-emerald-300",
  PAUSED: "bg-amber-500/15 text-amber-300",
  FAILED: "bg-red-500/15 text-red-300",
  UNASSIGNED: "bg-fg/10 text-fg/50",
};

// Kafka Connect 面板（連線右鍵 overlay）：連接器清單 + 詳細 + 動作 + 設定編輯 + 新增。
export default function KafkaConnectPanel({ connId, connName, onClose }: {
  connId: string; connName: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [connectors, setConnectors] = useState<KafkaConnector[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [config, setConfig] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [plugins, setPlugins] = useState<KafkaConnectPlugin[]>([]);
  const [newName, setNewName] = useState("");
  const [newConfig, setNewConfig] = useState("{\n  \"connector.class\": \"\",\n  \"tasks.max\": \"1\"\n}");
  const [openTrace, setOpenTrace] = useState<number | null>(null);

  const load = () =>
    api.kafkaConnectList(connId).then(setConnectors).catch((e) => setErr(e?.message ?? String(e)));
  useEffect(() => { load(); }, [connId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selected) { setConfig(""); return; }
    setEditing(false);
    api.kafkaConnectConfig(connId, selected).then((c) => setConfig(JSON.stringify(c, null, 2))).catch(() => setConfig(""));
  }, [connId, selected]);

  const detail = connectors.find((c) => c.name === selected);

  const act = async (fn: () => Promise<void>, okMsg: string) => {
    try { await fn(); toast.success(okMsg); load(); }
    catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  const saveConfig = async () => {
    if (!selected) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(config); } catch { toast.error(t("設定非合法 JSON")); return; }
    await act(() => api.kafkaConnectPutConfig(connId, selected, parsed), t("已更新設定"));
    setEditing(false);
  };

  const startCreate = () => {
    setCreating(true);
    api.kafkaConnectPlugins(connId).then(setPlugins).catch(() => {});
  };

  const doCreate = async () => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(newConfig); } catch { toast.error(t("設定非合法 JSON")); return; }
    if (!newName.trim()) { toast.error(t("請輸入連接器名稱")); return; }
    try {
      const cls = String(parsed["connector.class"] ?? "");
      if (cls) {
        const v = await api.kafkaConnectValidate(connId, cls, parsed);
        if (v.error_count > 0) {
          toast.error(t("設定驗證失敗：{detail}", { detail: v.errors.map((e) => `${e.key}: ${e.value}`).join("; ") }));
          return;
        }
      }
      await api.kafkaConnectPutConfig(connId, newName.trim(), parsed);
      toast.success(t("已建立連接器 {name}", { name: newName.trim() }));
      setCreating(false);
      setNewName("");
      load();
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  const badge = (state: string) => (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATE_CLS[state] ?? STATE_CLS.UNASSIGNED}`}>{state}</span>
  );

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[920px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={Cable} size={14} className="text-cyan-300/90" />
          <span className="font-medium text-sm">{t("連接器")} · {connName}</span>
          <span className="text-xs text-fg/35">{connectors.length}</span>
          <button type="button" onClick={startCreate} className="ml-2 px-2 py-1 rounded bg-accent/80 hover:bg-accent text-white text-xs">{t("新增連接器")}</button>
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>

        {err && <div className="px-4 py-1.5 text-red-400 text-xs mono break-all border-b border-fg/10">{err}</div>}

        <div className="flex-1 min-h-0 flex text-xs">
          <div className="w-64 border-r border-fg/10 overflow-auto">
            {connectors.map((c) => (
              <button key={c.name} onClick={() => { setSelected(c.name); setCreating(false); }}
                className={`w-full text-left px-3 py-2 border-b border-fg/5 hover:bg-fg/5 ${selected === c.name ? "bg-accent/10" : ""}`}>
                <div className="flex items-center gap-1.5">
                  <span className="truncate flex-1" title={c.name}>{c.name}</span>
                  {badge(c.state)}
                </div>
                <div className="text-fg/35">{c.connector_type} · {c.tasks.length} tasks</div>
              </button>
            ))}
            {connectors.length === 0 && <div className="px-3 py-4 text-fg/30">{t("無連接器")}</div>}
          </div>

          <div className="flex-1 min-w-0 overflow-auto p-3">
            {creating ? (
              <div className="space-y-2">
                <div className="text-fg/60 font-medium">{t("新增連接器")}</div>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("連接器名稱")} className="w-full bg-inset border border-fg/10 rounded px-2 py-1.5 outline-none focus:border-accent" />
                {plugins.length > 0 && (
                  <select onChange={(e) => { if (e.target.value) { try { const c = JSON.parse(newConfig); c["connector.class"] = e.target.value; setNewConfig(JSON.stringify(c, null, 2)); } catch { /* keep */ } } }} className="w-full bg-inset border border-fg/10 rounded px-2 py-1.5 outline-none focus:border-accent">
                    <option value="">{t("選擇 plugin（填入 connector.class）…")}</option>
                    {plugins.map((p) => <option key={p.class} value={p.class}>{p.class.split(".").pop()} ({p.kind})</option>)}
                  </select>
                )}
                <div className="border border-fg/15 rounded overflow-hidden">
                  <CodeMirror value={newConfig} onChange={setNewConfig} extensions={[jsonLang()]} theme="dark" height="280px" basicSetup={{ foldGutter: false }} />
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={doCreate} className="px-3 py-1 rounded bg-accent/80 hover:bg-accent text-white">{t("驗證並建立")}</button>
                  <button type="button" onClick={() => setCreating(false)} className="px-3 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/60">{t("取消")}</button>
                </div>
              </div>
            ) : detail ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg/70">{detail.name}</span>
                  {badge(detail.state)}
                  <span className="text-fg/30">{detail.connector_type}</span>
                  <span className="ml-auto flex gap-2">
                    {detail.state === "PAUSED"
                      ? <button type="button" onClick={() => act(() => api.kafkaConnectResume(connId, detail.name), t("已恢復"))} className="text-emerald-300/80 hover:text-emerald-300">{t("恢復")}</button>
                      : <button type="button" onClick={() => act(() => api.kafkaConnectPause(connId, detail.name), t("已暫停"))} className="text-amber-300/80 hover:text-amber-300">{t("暫停")}</button>}
                    <button type="button" onClick={() => act(() => api.kafkaConnectRestart(connId, detail.name, true, false), t("已重啟"))} className="text-fg/50 hover:text-accent">{t("重啟")}</button>
                    <button type="button" onClick={() => act(() => api.kafkaConnectRestart(connId, detail.name, true, true), t("已重啟失敗任務"))} className="text-fg/50 hover:text-accent">{t("重啟失敗任務")}</button>
                    <button type="button" onClick={async () => { if (await uiConfirm(t("刪除連接器「{name}」？", { name: detail.name }), { danger: true })) { act(() => api.kafkaConnectDelete(connId, detail.name), t("已刪除")); setSelected(null); } }} className="text-fg/50 hover:text-red-400">{t("刪除")}</button>
                  </span>
                </div>

                <div>
                  <div className="text-fg/40 mb-1">{t("任務")}</div>
                  {detail.tasks.map((tk) => (
                    <div key={tk.id} className="border-b border-fg/5 py-1">
                      <div className="flex items-center gap-2">
                        <span className="mono text-fg/60">#{tk.id}</span>
                        {badge(tk.state)}
                        <span className="text-fg/30">{tk.worker_id}</span>
                        {tk.trace && <button type="button" onClick={() => setOpenTrace(openTrace === tk.id ? null : tk.id)} className="text-fg/40 hover:text-accent">{openTrace === tk.id ? t("收合") : t("錯誤")}</button>}
                        <button type="button" onClick={() => act(() => api.kafkaConnectRestartTask(connId, detail.name, tk.id), t("已重啟任務"))} className="ml-auto text-fg/40 hover:text-accent">{t("重啟")}</button>
                      </div>
                      {openTrace === tk.id && tk.trace && <pre className="bg-inset rounded p-2 mono whitespace-pre-wrap break-all text-red-300/80 mt-1">{tk.trace}</pre>}
                    </div>
                  ))}
                </div>

                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-fg/40">{t("設定")}</span>
                    {editing
                      ? <><button type="button" onClick={saveConfig} className="text-accent hover:underline">{t("儲存")}</button><button type="button" onClick={() => setEditing(false)} className="text-fg/40 hover:underline">{t("取消")}</button></>
                      : <button type="button" onClick={() => setEditing(true)} className="text-fg/40 hover:text-accent">{t("編輯")}</button>}
                  </div>
                  {editing
                    ? <div className="border border-fg/15 rounded overflow-hidden"><CodeMirror value={config} onChange={setConfig} extensions={[jsonLang()]} theme="dark" height="220px" basicSetup={{ foldGutter: false }} /></div>
                    : <pre className="bg-inset rounded p-2 mono whitespace-pre-wrap break-all">{config}</pre>}
                </div>
              </div>
            ) : (
              <div className="text-fg/30">{t("左側選一個連接器。")}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
