// 資源瀏覽器：叢集支援的任何資源種類（含 CRD，來自 discovery），以 API server 的 server-side printing
// 表格呈現（欄位與 `kubectl get` 相同，勾「更多欄位」= `-o wide`）。點名稱開資源分頁。
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { api } from "./api";
import type { K8sApiResource, K8sTable } from "./k8sTypes";
import { BUILTIN, CLUSTER_DB } from "./k8sModel";
import { errText, openK8sTab } from "./k8sActions";
import { ErrorLine } from "./dockerUi";
import { Button, Input, Select, Spinner } from "./ui/index";
import { useT } from "./i18n";

/** discovery 項目 → 下拉選單的值（`plural.group`）。 */
const keyOf = (r: Pick<K8sApiResource, "plural" | "group">) => (r.group ? `${r.plural}.${r.group}` : r.plural);

/** 開分頁用的 table 名稱：內建種類用裸複數，其他帶 group。 */
function tableKey(r: K8sApiResource): string {
  const b = BUILTIN[r.plural];
  return b && b.ref.group === r.group ? r.plural : keyOf(r);
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function K8sBrowser({ connId, ns, initial }: { connId: string; ns: string | null; initial: string }) {
  const t = useT();
  const [disc, setDisc] = useState<K8sApiResource[] | null>(null);
  const [sel, setSel] = useState(initial || "pods");
  const [allNs, setAllNs] = useState(ns === null);
  const [wide, setWide] = useState(false);
  const [selector, setSelector] = useState("");
  const [appliedSelector, setAppliedSelector] = useState("");
  const [filter, setFilter] = useState("");
  const [table, setTable] = useState<K8sTable | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.k8sDiscovery(connId).then(setDisc).catch((e) => setErr(errText(e)));
  }, [connId]);

  // 只列可 list 的種類；內建常用的排前面，其餘依 group 排序。
  const options = useMemo(() => {
    const list = (disc ?? []).filter((r) => r.verbs.includes("list"));
    const rank = (r: K8sApiResource) => (BUILTIN[r.plural]?.ref.group === r.group ? 0 : 1);
    return [...list].sort((a, b) => rank(a) - rank(b) || a.group.localeCompare(b.group) || a.plural.localeCompare(b.plural));
  }, [disc]);
  const res = options.find((r) => keyOf(r) === sel) ?? null;

  const load = useCallback(async () => {
    if (!res) return;
    setLoading(true);
    try {
      setTable(await api.k8sTable(connId, res, res.namespaced && !allNs ? ns : null, appliedSelector || null));
      setErr(null);
    } catch (e) {
      setErr(errText(e));
      setTable(null);
    } finally {
      setLoading(false);
    }
  }, [connId, res, allNs, ns, appliedSelector]);

  useEffect(() => { void load(); }, [load]);

  const cols = (table?.columns ?? []).map((c, i) => ({ ...c, i })).filter((c) => wide || c.priority === 0);
  const q = filter.trim().toLowerCase();
  const rows = (table?.rows ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.cells.some((c) => cellText(c).toLowerCase().includes(q)));
  const showNs = !!res?.namespaced && (allNs || ns === null);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-fg/10 bg-bar text-xs flex-wrap">
        <Select value={sel} onChange={(e) => setSel(e.target.value)} className="w-64" title={t("資源種類")}>
          {!res && <option value={sel}>{sel}</option>}
          {options.map((r) => (
            <option key={keyOf(r)} value={keyOf(r)}>
              {r.kind} · {keyOf(r)}{r.namespaced ? "" : " (cluster)"}
            </option>
          ))}
        </Select>
        {ns !== null && res?.namespaced && (
          <label className="flex items-center gap-1 cursor-pointer select-none text-fg/60">
            <input type="checkbox" checked={allNs} onChange={(e) => setAllNs(e.target.checked)} />
            {t("全部 namespace")}
          </label>
        )}
        <label className="flex items-center gap-1 cursor-pointer select-none text-fg/60">
          <input type="checkbox" checked={wide} onChange={(e) => setWide(e.target.checked)} />
          {t("更多欄位")}
        </label>
        <Input
          value={selector}
          onChange={(e) => setSelector(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") setAppliedSelector(selector.trim()); }}
          placeholder={t("label selector（如 app=web），Enter 套用")}
          className="w-56"
        />
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg/30" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("篩選…")}
            className="w-40 bg-inset border border-fg/10 rounded pl-6 pr-2 py-0.5 outline-none focus:border-accent"
          />
        </div>
        <Button size="sm" icon={RefreshCw} loading={loading} onClick={() => void load()}>{t("重新整理")}</Button>
        {table && <span className="ml-auto text-fg/40">{t("{n} 筆", { n: rows.length })}</span>}
      </div>
      <ErrorLine text={err} />
      <div className="flex-1 min-h-0 overflow-auto">
        {!table ? (
          !err && <div className="flex justify-center p-6"><Spinner /></div>
        ) : (
          <table className="w-full text-xs" data-testid="k8s-browser-table">
            <thead className="sticky top-0 bg-panel">
              <tr className="text-left text-fg/45 border-b border-fg/10">
                {showNs && <th className="px-3 py-1.5 font-normal whitespace-nowrap">Namespace</th>}
                {cols.map((c) => <th key={c.i} className="px-3 py-1.5 font-normal whitespace-nowrap" title={c.description}>{c.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.namespace}/${r.name}`} className="border-b border-fg/5 hover:bg-fg/[0.03]">
                  {showNs && <td className="px-3 py-1 mono text-fg/60 whitespace-nowrap">{r.namespace}</td>}
                  {cols.map((c) => (
                    <td key={c.i} className="px-3 py-1 mono whitespace-nowrap">
                      {c.name === "Name" && res ? (
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          onClick={() => openK8sTab(connId, res.namespaced ? r.namespace : CLUSTER_DB, `${tableKey(res)}/${r.name}`)}
                        >
                          {cellText(r.cells[c.i])}
                        </button>
                      ) : cellText(r.cells[c.i])}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td className="px-3 py-3 text-fg/35" colSpan={cols.length + (showNs ? 1 : 0)}>{t("（沒有資源）")}</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
