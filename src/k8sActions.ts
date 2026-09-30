// Kubernetes 操作（確認對話框 + 呼叫後端 + toast）：側欄右鍵選單與資源分頁的動作列共用。
// 回傳 true = 已執行成功（呼叫端據此重新整理），false = 使用者取消或失敗（已 toast）。
// 需要表單的動作（port-forward、套用 YAML、叢集總覽）經 `useK8sUi` 請 App 根部的 K8sDialogs 開對話框。
import { create } from "zustand";
import { api, type ConnectionConfig } from "./api";
import type { K8sObject } from "./k8sTypes";
import { builtinRef, canForward, defaultContainer, forwardablePorts, forwardTarget, kindOf, templateContainers } from "./k8sModel";
import { guessDbFromImage } from "./dockerDbGuess";
import { useConnPrefill } from "./connPrefill";
import { useStore } from "./store";
import { t } from "./i18n";
import { toast, uiConfirm, uiPrompt } from "./ui";

export function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** 對話框請求（發起端在側欄 / 分頁深處，擁有者是 App 根部的 K8sDialogs）。 */
export interface K8sForwardReq { connId: string; ns: string; plural: string; name: string; port?: number }
export interface K8sApplyReq { connId: string; ns: string | null; initial?: string }

export const useK8sUi = create<{
  forward: K8sForwardReq | null;
  apply: K8sApplyReq | null;
  overview: string | null;
  openForward: (r: K8sForwardReq) => void;
  openApply: (r: K8sApplyReq) => void;
  openOverview: (connId: string) => void;
  close: (which: "forward" | "apply" | "overview") => void;
}>((set) => ({
  forward: null,
  apply: null,
  overview: null,
  openForward: (r) => set({ forward: r }),
  openApply: (r) => set({ apply: r }),
  openOverview: (connId) => set({ overview: connId }),
  close: (which) => set({ [which]: null } as Partial<{ forward: null; apply: null; overview: null }>),
}));

/** 分頁的子頁請求（右鍵「Log…」「Shell…」→ 開分頁後由 K8sObjectView 消費）。 */
export type K8sSub = "summary" | "yaml" | "events" | "logs" | "shell" | "metrics" | "pods";

export const useK8sSub = create<{
  req: Record<string, K8sSub>;
  request: (key: string, sub: K8sSub) => void;
  consume: (key: string) => void;
}>((set) => ({
  req: {},
  request: (key, sub) => set((s) => ({ req: { ...s.req, [key]: sub } })),
  consume: (key) =>
    set((s) => {
      if (!(key in s.req)) return s;
      const req = { ...s.req };
      delete req[key];
      return { req };
    }),
}));

/** 開資源分頁（`table` = `種類/名稱`，或 `@browse:<plural>` 資源瀏覽器）。可指定一開就切到的子頁。 */
export function openK8sTab(connId: string, ns: string, table: string, sub?: K8sSub, objKind?: string) {
  useStore.getState().openTable(connId, ns, table, "data", objKind);
  if (sub) useK8sSub.getState().request(`${connId}:${ns}:${table}`, sub);
}

export function refreshTree(connId: string, ns: string) {
  useStore.getState().requestTreeReload(connId, ns);
}

export async function deleteResource(connId: string, ns: string | null, plural: string, name: string): Promise<boolean> {
  const ref = builtinRef(plural);
  if (!ref) return false;
  const kind = kindOf(plural);
  if (plural === "namespaces") {
    const typed = await uiPrompt(t("刪除 namespace 會一併刪除其中所有資源。請輸入「{name}」確認：", { name }), {
      title: t("刪除 namespace"),
      confirmText: t("刪除"),
    });
    if (typed !== name) return false;
  } else {
    const ok = await uiConfirm(t("確定刪除 {kind}「{name}」？此操作不可復原。", { kind, name }), {
      title: t("刪除 {kind}", { kind }),
      danger: true,
      confirmText: t("刪除"),
    });
    if (!ok) return false;
  }
  try {
    await api.k8sDelete(connId, ref, ns, name, false);
    toast.success(t("已刪除 {kind} {name}", { kind, name }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

/** 立即刪除 Pod（grace period 0）：卡在 Terminating 時用。 */
export async function forceDeletePod(connId: string, ns: string, name: string): Promise<boolean> {
  const ok = await uiConfirm(t("強制刪除 Pod「{name}」（不等待正常結束）？卡在 Terminating 時才建議使用。", { name }), {
    title: t("強制刪除"),
    danger: true,
    confirmText: t("強制刪除"),
  });
  if (!ok) return false;
  try {
    await api.k8sDelete(connId, builtinRef("pods")!, ns, name, true);
    toast.success(t("已刪除 {kind} {name}", { kind: "Pod", name }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

export async function scaleWorkload(connId: string, ns: string, plural: string, name: string, current: number): Promise<boolean> {
  const v = await uiPrompt(t("{kind}「{name}」的副本數：", { kind: kindOf(plural), name }), {
    title: t("調整副本數"),
    defaultValue: String(current),
    confirmText: t("套用"),
  });
  if (v == null) return false;
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n < 0) {
    toast.error(t("副本數必須是 0 以上的整數"));
    return false;
  }
  if (n === 0) {
    const ok = await uiConfirm(t("副本數設為 0 會停掉「{name}」的所有 Pod，確定？", { name }), { danger: true, confirmText: t("套用") });
    if (!ok) return false;
  }
  try {
    await api.k8sScale(connId, builtinRef(plural)!, ns, name, n);
    toast.success(t("已將 {name} 調整為 {n} 個副本", { name, n }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

export async function restartWorkload(connId: string, ns: string, plural: string, name: string): Promise<boolean> {
  const ok = await uiConfirm(t("重新啟動 {kind}「{name}」的所有 Pod（依更新策略逐步替換）？", { kind: kindOf(plural), name }), {
    confirmText: t("重新啟動"),
  });
  if (!ok) return false;
  try {
    await api.k8sRestart(connId, builtinRef(plural)!, ns, name);
    toast.success(t("已要求重新啟動 {name}", { name }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

export async function triggerCronJob(connId: string, ns: string, name: string): Promise<string | null> {
  const ok = await uiConfirm(t("立即從 CronJob「{name}」建立一個 Job 執行？", { name }), { confirmText: t("立即執行") });
  if (!ok) return null;
  try {
    const job = await api.k8sCronjobTrigger(connId, ns, name);
    toast.success(t("已建立 Job {job}", { job }));
    return job;
  } catch (e) {
    toast.error(errText(e));
    return null;
  }
}

export async function setCronJobSuspend(connId: string, ns: string, name: string, suspend: boolean): Promise<boolean> {
  try {
    await api.k8sCronjobSuspend(connId, ns, name, suspend);
    toast.success(suspend ? t("已暫停排程 {name}", { name }) : t("已恢復排程 {name}", { name }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

export async function cordonNode(connId: string, name: string, cordon: boolean): Promise<boolean> {
  if (cordon) {
    const ok = await uiConfirm(t("將節點「{name}」設為不可排程（cordon）？既有 Pod 不受影響，新 Pod 不會排到這台。", { name }), {
      confirmText: t("停止排程"),
    });
    if (!ok) return false;
  }
  try {
    await api.k8sNodeCordon(connId, name, cordon);
    toast.success(cordon ? t("已停止排程到 {name}", { name }) : t("已恢復排程到 {name}", { name }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

/** 物件的主要映像（Pod / workload 的第一個容器）。 */
function mainImage(o: K8sObject, plural: string): string {
  return templateContainers(o, plural)[0]?.image ?? "";
}

/** 看映像能不能認出是資料庫（右鍵選單決定要不要顯示「建立資料庫連線」）。 */
export function k8sLooksLikeDb(images: string[]): boolean {
  return images.some((i) => guessDbFromImage(i, {}) !== null);
}

/**
 * 從 Pod / Service / workload 建資料庫連線：找到後端 Pod → 依映像推測 DB 類型、從環境變數（含 Secret）取帳密 →
 * 開預填好的新增連線對話框，連線方式設成「經由這個 Kubernetes 連線 port-forward」。
 */
export async function createDbConnectionFromK8s(conn: ConnectionConfig, ns: string, plural: string, name: string): Promise<void> {
  try {
    if (!canForward(plural)) return;
    const target = forwardTarget(plural, name);
    const obj = await api.k8sGet(conn.id, builtinRef(plural)!, ns, name);
    // 找一個實際的 Pod：映像與 env 以 Pod 為準（Service 本身沒有映像）。
    const ports = forwardablePorts(obj, plural);
    const [podName] = await api.k8sResolveTarget(conn.id, ns, target, ports[0]?.port ?? 0);
    const pod = plural === "pods" ? obj : await api.k8sGet(conn.id, builtinRef("pods")!, ns, podName);
    const container = defaultContainer(pod);
    const envList = await api.k8sPodEnv(conn.id, ns, podName).catch(() => []);
    const images = templateContainers(pod, "pods");
    let guess: ReturnType<typeof guessDbFromImage> = null;
    // 先試預設容器，再試其他容器（sidecar 在前面的情形）。
    for (const c of [...images.filter((x) => x.name === container), ...images.filter((x) => x.name !== container)]) {
      const env = Object.fromEntries(envList.filter((e) => e.container === c.name).map((e) => [e.name, e.value]));
      guess = guessDbFromImage(c.image, env);
      if (guess) break;
    }
    if (!guess) {
      toast.info(t("認不出「{name}」是哪種資料庫（映像 {image}）", { name, image: mainImage(pod, "pods") }));
      return;
    }
    // Service：用 service port（對應到 DB 容器埠的那個）；其他：容器埠。
    let remote = guess.port;
    if (plural === "services") {
      const svcPorts = (obj.spec?.ports ?? []) as any[];
      const hit = svcPorts.find((p) => String(p.targetPort) === String(guess!.port) || p.port === guess!.port)
        ?? svcPorts.find((p) => typeof p.targetPort === "string");
      if (hit) remote = hit.port;
    }
    useConnPrefill.getState().open({
      kind: guess.kind,
      name: `${name} (${ns})`,
      host: "127.0.0.1",
      port: guess.port,
      username: guess.username,
      password: guess.password,
      database: guess.database || null,
      options: {
        ...(guess.options ?? {}),
        k8s_conn: conn.id,
        k8s_ns: ns,
        k8s_target: target,
        k8s_port: String(remote),
      },
    });
  } catch (e) {
    toast.error(errText(e));
  }
}
