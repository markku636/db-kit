import { useState } from "react";
import { api } from "./api";
import { toast } from "./ui";

type RType = "string" | "list" | "set" | "hash" | "zset";

const TYPES: { v: RType; label: string }[] = [
  { v: "string", label: "String" },
  { v: "list", label: "List" },
  { v: "set", label: "Set" },
  { v: "hash", label: "Hash" },
  { v: "zset", label: "ZSet" },
];

// 新增 Redis 鍵：選型別 + 初始元素。沿用既有 API（insert_row / key_edit），
// list/set/hash/zset 由對應寫入指令自動建立該鍵。
export default function NewKeyDialog({ connId, database, onClose, onCreated }: {
  connId: string; database: string; onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<RType>("string");
  const [value, setValue] = useState("");   // string value / list value / set member / hash value / zset member
  const [field, setField] = useState("");   // hash field
  const [score, setScore] = useState("0");  // zset score
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) { setErr("請輸入鍵名"); return; }
    setBusy(true);
    setErr(null);
    try {
      switch (type) {
        case "string":
          await api.insertRow(connId, database, "keys", {
            columns: ["key", "value"],
            values: [name, value],
          });
          break;
        case "list":
          await api.keyEdit(connId, database, name, { action: "list_push", value, front: false });
          break;
        case "set":
          await api.keyEdit(connId, database, name, { action: "set_add", member: value });
          break;
        case "hash":
          await api.keyEdit(connId, database, name, { action: "hash_set", field, value });
          break;
        case "zset": {
          const s = Number(score);
          if (!Number.isFinite(s)) { setErr("score 必須為數字"); setBusy(false); return; }
          await api.keyEdit(connId, database, name, { action: "zset_add", member: value, score: s });
          break;
        }
      }
      toast.success(`已建立鍵 ${name}`);
      onCreated();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? "建立失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[420px] max-w-[92vw] rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 font-medium text-sm">新增鍵（DB {database}）</div>
        <div className="p-5 space-y-3">
          {err && <div className="text-red-400 text-sm mono break-all">{err}</div>}

          <div className="space-y-1">
            <label className="text-xs text-white/50">鍵名</label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 user:1000"
              className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-sm mono outline-none focus:border-blue-500" />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-white/50">型別</label>
            <div className="flex gap-1">
              {TYPES.map((t) => (
                <button key={t.v} type="button" onClick={() => setType(t.v)}
                  className={`px-2.5 py-1 text-xs rounded ${type === t.v ? "bg-blue-600 text-white" : "bg-white/5 text-white/60 hover:bg-white/10"}`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {type === "hash" && (
            <div className="space-y-1">
              <label className="text-xs text-white/50">field</label>
              <input value={field} onChange={(e) => setField(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-sm mono outline-none focus:border-blue-500" />
            </div>
          )}
          {type === "zset" && (
            <div className="space-y-1">
              <label className="text-xs text-white/50">score</label>
              <input type="number" value={score} onChange={(e) => setScore(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-sm mono outline-none focus:border-blue-500" />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-white/50">
              {type === "string" ? "value" : type === "set" || type === "zset" ? "member" : "value"}
            </label>
            <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={type === "string" ? 4 : 2}
              className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-sm mono outline-none focus:border-blue-500 resize-none break-all" />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">取消</button>
          <button type="button" disabled={busy} onClick={submit}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40">
            {busy ? "建立中…" : "建立"}
          </button>
        </div>
      </div>
    </div>
  );
}
