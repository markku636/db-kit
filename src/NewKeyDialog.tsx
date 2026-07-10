import { useState } from "react";
import { KeyRound } from "lucide-react";
import { api } from "./api";
import { toast } from "./ui";
import { Modal, Button, Input, Textarea } from "./ui/index";

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
          if (!field.trim()) { setErr("請輸入 hash field"); setBusy(false); return; }
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
    <Modal
      onClose={onClose}
      title={`新增鍵（DB ${database}）`}
      icon={KeyRound}
      size="sm"
      zClass="z-[60]"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={<>
        <Button variant="secondary" onClick={onClose}>取消</Button>
        <Button variant="primary" loading={busy} disabled={busy} onClick={submit}>建立</Button>
      </>}
    >
      {err && <div className="text-red-400 text-sm mono break-all">{err}</div>}

          <div className="space-y-1">
            <label className="text-xs text-fg/50">鍵名</label>
            <Input autoFocus inputSize="md" className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 user:1000" />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-fg/50">型別</label>
            <div className="flex gap-1">
              {TYPES.map((opt) => (
                <button key={opt.v} type="button" onClick={() => setType(opt.v)}
                  className={`px-2.5 py-1 text-xs rounded ${type === opt.v ? "bg-accent text-white" : "bg-fg/5 text-fg/60 hover:bg-fg/10"}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {type === "hash" && (
            <div className="space-y-1">
              <label className="text-xs text-fg/50">field</label>
              <Input aria-label="field" inputSize="md" className="mono" value={field} onChange={(e) => setField(e.target.value)} />
            </div>
          )}
          {type === "zset" && (
            <div className="space-y-1">
              <label className="text-xs text-fg/50">score</label>
              <Input aria-label="score" type="number" inputSize="md" className="mono" value={score} onChange={(e) => setScore(e.target.value)} />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-fg/50">
              {type === "string" ? "value" : type === "set" || type === "zset" ? "member" : "value"}
            </label>
            <Textarea aria-label="值" value={value} onChange={(e) => setValue(e.target.value)} rows={type === "string" ? 4 : 2}
              className="mono resize-none break-all" />
          </div>
    </Modal>
  );
}
