import { useEffect, useMemo, useState } from "react";
import { Shield, X } from "lucide-react";
import { api, type KafkaAclBinding } from "./api";
import { toast, uiConfirm, useModalOverlay } from "./ui";
import { IconButton, EmptyState } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

const RES_TYPES = ["topic", "group", "cluster", "transactional_id"];
const PATTERNS = ["literal", "prefixed"];
const OPS = ["read", "write", "create", "delete", "alter", "describe", "describe_configs", "alter_configs", "cluster_action", "idempotent_write", "all"];
const PERMS = ["allow", "deny"];

function anyFilter(): KafkaAclBinding {
  return { resource_type: "any", name: "", pattern_type: "any", principal: "", host: "", operation: "any", permission: "any" };
}
function blankAcl(): KafkaAclBinding {
  return { resource_type: "topic", name: "", pattern_type: "literal", principal: "User:", host: "*", operation: "read", permission: "allow" };
}

// ACL 面板（連線右鍵 overlay）：依 principal 分組 + 篩選 + 新增 / 刪除。
export default function KafkaAclPanel({ connId, connName, onClose }: {
  connId: string; connName: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [acls, setAcls] = useState<KafkaAclBinding[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterPrincipal, setFilterPrincipal] = useState("");
  const [filterResType, setFilterResType] = useState("any");
  const [creating, setCreating] = useState<KafkaAclBinding | null>(null);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.kafkaAclsList(connId, anyFilter())
      .then(setAcls)
      .catch((e) => setErr(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [connId]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => acls.filter((a) =>
    (filterResType === "any" || a.resource_type === filterResType) &&
    (!filterPrincipal.trim() || a.principal.toLowerCase().includes(filterPrincipal.trim().toLowerCase()))
  ), [acls, filterResType, filterPrincipal]);

  const byPrincipal = useMemo(() => {
    const m = new Map<string, KafkaAclBinding[]>();
    for (const a of filtered) {
      (m.get(a.principal) ?? m.set(a.principal, []).get(a.principal)!).push(a);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const create = async () => {
    if (!creating) return;
    try {
      await api.kafkaAclsCreate(connId, [creating]);
      toast.success(t("已建立 ACL"));
      setCreating(null);
      load();
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  const del = async (a: KafkaAclBinding) => {
    if (!(await uiConfirm(t("刪除此 ACL？（{principal} {op} {res}）", { principal: a.principal, op: a.operation, res: a.name || a.resource_type }), { danger: true }))) return;
    try {
      // 以精確 filter 刪除單筆。
      await api.kafkaAclsDelete(connId, a);
      toast.success(t("已刪除 ACL"));
      load();
    } catch (e: any) { toast.error(e?.message ?? String(e)); }
  };

  const inputCls = "bg-inset border border-fg/10 rounded px-2 py-1 outline-none focus:border-accent";
  const permBadge = (p: string) => (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${p === "deny" ? "bg-red-500/15 text-red-300" : "bg-emerald-500/15 text-emerald-300"}`}>{p}</span>
  );

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-app w-[900px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={Shield} size={14} className="text-indigo-300/90" />
          <span className="font-medium text-sm">ACL · {connName}</span>
          <span className="text-xs text-fg/35">{acls.length}</span>
          <button type="button" onClick={() => setCreating(blankAcl())} className="ml-2 px-2 py-1 rounded bg-accent/80 hover:bg-accent text-white text-xs">{t("新增 ACL")}</button>
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>

        <div className="px-4 py-2 border-b border-fg/10 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-fg/40">{t("篩選")}</span>
          <input value={filterPrincipal} onChange={(e) => setFilterPrincipal(e.target.value)} placeholder="User:…" className={`${inputCls} w-48`} />
          <select value={filterResType} onChange={(e) => setFilterResType(e.target.value)} className={inputCls}>
            <option value="any">{t("全部資源")}</option>
            {RES_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        {creating && (
          <div className="px-4 py-2 border-b border-fg/10 flex flex-wrap items-end gap-2 text-xs bg-inset/40">
            <label className="flex flex-col gap-0.5"><span className="text-fg/40">principal</span><input value={creating.principal} onChange={(e) => setCreating({ ...creating, principal: e.target.value })} className={`${inputCls} w-40`} /></label>
            <label className="flex flex-col gap-0.5"><span className="text-fg/40">{t("資源")}</span><select value={creating.resource_type} onChange={(e) => setCreating({ ...creating, resource_type: e.target.value })} className={inputCls}>{RES_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
            {creating.resource_type !== "cluster" && <label className="flex flex-col gap-0.5"><span className="text-fg/40">{t("名稱")}</span><input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} className={`${inputCls} w-32`} /></label>}
            <label className="flex flex-col gap-0.5"><span className="text-fg/40">pattern</span><select value={creating.pattern_type} onChange={(e) => setCreating({ ...creating, pattern_type: e.target.value })} className={inputCls}>{PATTERNS.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
            <label className="flex flex-col gap-0.5"><span className="text-fg/40">{t("操作")}</span><select value={creating.operation} onChange={(e) => setCreating({ ...creating, operation: e.target.value })} className={inputCls}>{OPS.map((o) => <option key={o} value={o}>{o}</option>)}</select></label>
            <label className="flex flex-col gap-0.5"><span className="text-fg/40">{t("權限")}</span><select value={creating.permission} onChange={(e) => setCreating({ ...creating, permission: e.target.value })} className={inputCls}>{PERMS.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
            <label className="flex flex-col gap-0.5"><span className="text-fg/40">host</span><input value={creating.host} onChange={(e) => setCreating({ ...creating, host: e.target.value })} className={`${inputCls} w-20`} /></label>
            <button type="button" onClick={create} className="px-3 py-1 rounded bg-accent/80 hover:bg-accent text-white">{t("建立")}</button>
            <button type="button" onClick={() => setCreating(null)} className="px-3 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/60">{t("取消")}</button>
          </div>
        )}

        {err && <div className="px-4 py-1.5 text-red-400 text-xs mono break-all border-b border-fg/10">{err}</div>}

        <div className="flex-1 min-h-0 overflow-auto p-3 text-xs">
          {err && acls.length === 0 && (
            <EmptyState title={t("無法載入 ACL")} hint={err} />
          )}
          {!err && !loading && acls.length === 0 && (
            <EmptyState title={t("無 ACL")} hint={t("叢集尚無 ACL，或授權器未啟用。")} />
          )}
          {byPrincipal.map(([principal, list]) => (
            <div key={principal} className="mb-3">
              <div className="text-fg/70 mono font-medium mb-1">{principal} <span className="text-fg/35">({list.length})</span></div>
              <table className="w-full text-left mono">
                <tbody>
                  {list.map((a, i) => (
                    <tr key={i} className="border-b border-fg/5 group">
                      <td className="px-2 py-1 w-6">{permBadge(a.permission)}</td>
                      <td className="px-2 py-1 text-fg/60">{a.operation}</td>
                      <td className="px-2 py-1 text-fg/60">{a.resource_type}{a.name ? `:${a.name}` : ""} <span className="text-fg/30">({a.pattern_type})</span></td>
                      <td className="px-2 py-1 text-fg/40">{a.host}</td>
                      <td className="px-2 py-1 text-right"><button type="button" onClick={() => del(a)} className="opacity-0 group-hover:opacity-100 text-fg/40 hover:text-red-400">{t("刪除")}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
