// 連線對話框裡的 Kubernetes 欄位：
// - K8sClusterFields：Kubernetes 連線本身（kubeconfig + context，或手填 API server + token / 憑證）；
// - K8sForwardFields：一般資料庫連線「經由 Kubernetes port-forward」（選 Kubernetes 連線、namespace、目標、遠端埠）。
// 值都存在 options 的 `k8s_*` 鍵（非機密）；token 走 password 欄（OS keychain）。
import { useEffect, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { api, type ConnectionConfig } from "./api";
import type { K8sContextInfo } from "./k8sTypes";
import { k8sForwardEnabled, type K8sOpts } from "./k8sModel";

export { k8sForwardEnabled, k8sOptionsFor, pickK8sOpts, type K8sOpts } from "./k8sModel";
import { Button, Field, Input, Segmented, Select, Textarea } from "./ui/index";
import { pickOpenFile } from "./ui";
import { useStore } from "./store";
import { useT } from "./i18n";

function PathInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const t = useT();
  return (
    <div className="flex gap-2">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <Button variant="ghost" icon={FolderOpen} onClick={async () => { const p = await pickOpenFile([]); if (p) onChange(p); }}>{t("瀏覽")}</Button>
    </div>
  );
}

export function K8sClusterFields({ opts, setOpt, host, setHost, password, setPassword, editing }: {
  opts: K8sOpts;
  setOpt: (k: string, v: string) => void;
  host: string;
  setHost: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  editing: boolean;
}) {
  const t = useT();
  const manual = opts.k8s_source === "manual";
  const [contexts, setContexts] = useState<K8sContextInfo[] | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [defaults, setDefaults] = useState<string[]>([]);

  const loadContexts = async (path = opts.k8s_kubeconfig ?? "") => {
    setLoading(true);
    try {
      const info = await api.k8sKubeconfigContexts(path.trim() || null);
      setContexts(info.contexts);
      setFiles(info.files);
      setErr(null);
      // 還沒選 context：預選 current-context，並把 server 放進 host（側欄顯示用）。
      const cur = opts.k8s_context || info.current_context;
      const hit = info.contexts.find((c) => c.name === cur);
      if (hit && !opts.k8s_context) setOpt("k8s_context", hit.name);
      if (hit) setHost(hit.server);
    } catch (e: any) {
      setContexts(null);
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.k8sDefaultKubeconfig().then(setDefaults).catch(() => undefined);
    if (!manual) void loadContexts();
  }, [manual]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = contexts?.find((c) => c.name === opts.k8s_context);
  return (
    <>
      <Field label={t("連線方式")}>
        <Segmented
          full
          ariaLabel={t("Kubernetes 連線方式")}
          value={manual ? "manual" : "kubeconfig"}
          onChange={(v) => setOpt("k8s_source", v === "manual" ? "manual" : "")}
          options={[
            { value: "kubeconfig", label: "kubeconfig", title: t("讀 kubeconfig 檔（支援 token、憑證、exec plugin：EKS / GKE / AKS…）") },
            { value: "manual", label: t("手動填寫"), title: t("直接填 API server 網址與 Bearer token / 用戶端憑證") },
          ]}
        />
      </Field>
      {!manual ? (
        <>
          <Field label={t("kubeconfig 檔案（選填）")} hint={t("留空＝{path}；多個檔案用 ; 分隔", { path: defaults.join(" ; ") || "~/.kube/config" })}>
            <div className="flex gap-2">
              <Input value={opts.k8s_kubeconfig ?? ""} onChange={(e) => setOpt("k8s_kubeconfig", e.target.value)} placeholder={defaults[0] ?? "~/.kube/config"} />
              <Button variant="ghost" icon={FolderOpen} onClick={async () => {
                const p = await pickOpenFile([]);
                if (p) { setOpt("k8s_kubeconfig", p); void loadContexts(p); }
              }}>{t("瀏覽")}</Button>
              <Button variant="ghost" icon={RefreshCw} loading={loading} onClick={() => void loadContexts()}>{t("讀取")}</Button>
            </div>
          </Field>
          <Field label="Context" hint={selected ? `${selected.server} · ${t("認證")}：${selected.auth || "—"}${selected.namespace ? ` · ns ${selected.namespace}` : ""}` : files.length ? files.join(" ; ") : undefined}>
            <Select value={opts.k8s_context ?? ""} onChange={(e) => {
              setOpt("k8s_context", e.target.value);
              const c = contexts?.find((x) => x.name === e.target.value);
              setHost(c?.server ?? "");
            }}>
              <option value="">{t("（current-context）")}</option>
              {(contexts ?? []).map((c) => <option key={c.name} value={c.name}>{c.name}{c.current ? " ★" : ""}</option>)}
              {opts.k8s_context && contexts && !contexts.some((c) => c.name === opts.k8s_context) && <option value={opts.k8s_context}>{opts.k8s_context}</option>}
            </Select>
          </Field>
          {err && <div className="text-xs text-danger break-all">{err}</div>}
          {selected?.auth.startsWith("exec:") && (
            <div className="text-xs text-fg/45">
              {t("這個 context 用 exec plugin（{cmd}）取得 token：db-kit 會在背景執行它，請確認本機已安裝並登入過（例如 aws sso login、gcloud auth login）。", { cmd: selected.auth.slice(5) })}
            </div>
          )}
        </>
      ) : (
        <>
          <Field label={t("API server 網址")}>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://10.0.0.1:6443" />
          </Field>
          <Field label={t("Bearer token（選填）")} hint={t("存 OS keychain；ServiceAccount token 可用 kubectl create token <sa> 產生")}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={editing ? t("留空＝不變更") : ""} />
          </Field>
          <Field label={t("CA 憑證（選填）")} hint={t("PEM 檔案路徑或直接貼 PEM 內容")}>
            <PathInput value={opts.k8s_tls_ca ?? ""} onChange={(v) => setOpt("k8s_tls_ca", v)} placeholder="ca.crt" />
          </Field>
          <div className="flex gap-3">
            <Field label={t("用戶端憑證（選填）")} className="flex-1">
              <PathInput value={opts.k8s_tls_cert ?? ""} onChange={(v) => setOpt("k8s_tls_cert", v)} placeholder="client.crt" />
            </Field>
            <Field label={t("用戶端私鑰")} className="flex-1">
              <PathInput value={opts.k8s_tls_key ?? ""} onChange={(v) => setOpt("k8s_tls_key", v)} placeholder="client.key" />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={opts.k8s_tls_insecure === "1"} onChange={(e) => setOpt("k8s_tls_insecure", e.target.checked ? "1" : "")} />
            <span>{t("略過伺服器憑證驗證（自簽憑證、主機名不符時用）")}</span>
          </label>
        </>
      )}
      <Field label={t("限定 namespace（選填）")} hint={t("只顯示這些 namespace（逗號或換行分隔）；帳號沒有列出 namespace 的權限時必填")}>
        <Textarea value={opts.k8s_namespaces ?? ""} onChange={(e) => setOpt("k8s_namespaces", e.target.value)} rows={2} placeholder="default, team-a" />
      </Field>
    </>
  );
}

/** 資料庫連線的「經由 Kubernetes port-forward」。 */
export function K8sForwardFields({ opts, setOpt, defaultPort }: {
  opts: K8sOpts;
  setOpt: (k: string, v: string) => void;
  defaultPort: number;
}) {
  const t = useT();
  const k8sConns = useStore((s) => s.connections.filter((c: ConnectionConfig) => c.kind === "kubernetes"));
  const enabled = k8sForwardEnabled(opts);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);

  // 那個 Kubernetes 連線已連上時，順手列 namespace 給下拉建議。
  useEffect(() => {
    if (!opts.k8s_conn) return;
    api.k8sNamespaces(opts.k8s_conn).then(setNamespaces).catch(() => setNamespaces([]));
  }, [opts.k8s_conn]);

  if (k8sConns.length === 0 && !enabled) return null;
  return (
    <>
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            if (e.target.checked) {
              setOpt("k8s_conn", k8sConns[0]?.id ?? "");
              if (!opts.k8s_port) setOpt("k8s_port", String(defaultPort || ""));
            } else {
              setOpt("k8s_conn", "");
            }
          }}
        />
        <span>{t("經由 Kubernetes port-forward 連線")}</span>
      </label>
      {enabled && (
        <>
          <div className="text-xs text-fg/40">{t("連線時自動開一條 port-forward 到叢集內的 Pod / Service，上面的主機與埠不會使用。")}</div>
          <div className="flex gap-3">
            <Field label={t("Kubernetes 連線")} className="flex-1">
              <Select value={opts.k8s_conn ?? ""} onChange={(e) => setOpt("k8s_conn", e.target.value)}>
                {k8sConns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                {!k8sConns.some((c) => c.id === opts.k8s_conn) && <option value={opts.k8s_conn}>{t("（已刪除的連線）")}</option>}
              </Select>
            </Field>
            <Field label="Namespace" className="flex-1">
              <Input list="k8s-fwd-ns" value={opts.k8s_ns ?? ""} onChange={(e) => setOpt("k8s_ns", e.target.value)} placeholder="default" />
              <datalist id="k8s-fwd-ns">{namespaces.map((n) => <option key={n} value={n} />)}</datalist>
            </Field>
          </div>
          <div className="flex gap-3">
            <Field label={t("目標")} className="flex-1" hint={t("svc/名稱、pod/名稱、deploy/名稱 或 sts/名稱")}>
              <Input value={opts.k8s_target ?? ""} onChange={(e) => setOpt("k8s_target", e.target.value)} placeholder="svc/postgres" />
            </Field>
            <Field label={t("遠端埠")} className="w-28">
              <Input value={opts.k8s_port ?? ""} onChange={(e) => setOpt("k8s_port", e.target.value.replace(/\D/g, ""))} placeholder={String(defaultPort || "")} />
            </Field>
          </div>
          {opts.k8s_conn && opts.k8s_target && (
            <div className="text-xs text-fg/45 flex items-center gap-2">
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => {
                  setPreview(t("解析中…"));
                  api.k8sResolveTarget(opts.k8s_conn, opts.k8s_ns || "default", opts.k8s_target, Number(opts.k8s_port || defaultPort))
                    .then(([pod, port]) => setPreview(t("→ Pod {pod}，埠 {port}", { pod, port })))
                    .catch((e: any) => setPreview(e?.message ?? String(e)));
                }}
              >
                {t("檢查目標")}
              </button>
              {preview && <span className="break-all">{preview}</span>}
            </div>
          )}
        </>
      )}
    </>
  );
}
