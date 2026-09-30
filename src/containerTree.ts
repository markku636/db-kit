// 容器類連線（Docker / Registry / Harbor / Kubernetes）在側欄連線樹的呈現：database 層的標籤與圖示、
// 物件層（容器 / 映像 / tag / repository…）的圖示與色調。App.tsx 只呼叫這裡，不逐 kind 寫 JSX。
import {
  Box, CalendarClock, Container, Copy, Cpu, Database, FileCog, FolderGit2, Gauge, Globe, HardDrive, KeyRound, Layers, Layers3,
  ListChecks, Network, Package, Puzzle, Server, ShipWheel, Tag, type LucideIcon,
} from "lucide-react";
import type { DbKind } from "./api";
import { stateFromObjKind } from "./dockerModel";
import { CLUSTER_DB, parseObjKind, stateTone, TONE_TEXT } from "./k8sModel";
import { t } from "./i18n";

const DOCKER_CAT: Record<string, { label: string; icon: LucideIcon }> = {
  containers: { label: "容器", icon: Container },
  images: { label: "映像", icon: Layers },
  volumes: { label: "Volume", icon: HardDrive },
  networks: { label: "網路", icon: Network },
};

/** database 節點的顯示名與圖示；非容器類回 null（沿用原本的 Database 圖示 + 名稱）。 */
export function containerDbNode(kind: DbKind, db: string): { label: string; icon: LucideIcon } | null {
  if (kind === "docker") {
    const c = DOCKER_CAT[db];
    return c ? { label: t(c.label), icon: c.icon } : null;
  }
  if (kind === "registry") return { label: db, icon: Package };
  if (kind === "harbor") return { label: db, icon: FolderGit2 };
  if (kind === "kubernetes") return db === CLUSTER_DB ? { label: t("叢集資源"), icon: Server } : { label: db, icon: Layers3 };
  return null;
}

/** Kubernetes 資源種類的圖示（資料夾與物件共用）。 */
export const K8S_KIND_ICON: Record<string, LucideIcon> = {
  pods: Box, deployments: Layers, statefulsets: Database, daemonsets: Copy, jobs: ListChecks, cronjobs: CalendarClock,
  services: Network, ingresses: Globe, configmaps: FileCog, secrets: KeyRound, persistentvolumeclaims: HardDrive,
  horizontalpodautoscalers: Gauge, nodes: Cpu, persistentvolumes: HardDrive, storageclasses: Package,
  customresourcedefinitions: Puzzle,
};

export function k8sKindIcon(plural: string): LucideIcon {
  return K8S_KIND_ICON[plural] ?? ShipWheel;
}

/** 物件節點圖示 + 顏色 class；非容器類回 null。 */
export function containerObjIcon(kind: DbKind, objKind: string): { icon: LucideIcon; cls: string } | null {
  if (kind === "docker") {
    const st = stateFromObjKind(objKind);
    if (st !== null) {
      const cls =
        st === "running" ? "text-emerald-400"
        : st === "paused" ? "text-amber-400"
        : st === "restarting" ? "text-sky-400"
        : st === "dead" ? "text-red-400"
        : "text-fg/35";
      return { icon: Box, cls };
    }
    if (objKind === "image") return { icon: Layers, cls: "text-sky-300/80" };
    if (objKind === "image-dangling") return { icon: Layers, cls: "text-fg/35" };
    if (objKind === "volume") return { icon: HardDrive, cls: "text-amber-300/80" };
    if (objKind === "network") return { icon: Network, cls: "text-teal-300/80" };
    return { icon: Box, cls: "text-fg/50" };
  }
  if (kind === "registry") return { icon: Tag, cls: "text-sky-300/80" };
  if (kind === "harbor") return { icon: Package, cls: "text-lime-400/80" };
  if (kind === "kubernetes") {
    const k = parseObjKind(objKind);
    if (!k) return { icon: ShipWheel, cls: "text-fg/50" };
    const tone = stateTone(k.plural, k.state);
    // 沒有狀態意義的種類（ConfigMap / Secret…）用中性的淡色，不要整片灰。
    const cls = k.state === "" || tone === "neutral" && !["zero", "suspended", "succeeded"].includes(k.state) ? "text-sky-300/70" : TONE_TEXT[tone];
    return { icon: k8sKindIcon(k.plural), cls };
  }
  return null;
}

/** 物件節點的 tooltip。 */
export function containerObjTitle(kind: DbKind, objKind: string): string | null {
  if (kind === "docker") {
    const st = stateFromObjKind(objKind);
    if (st !== null) return t("容器（{state}）· 單擊開啟；右鍵啟停 / Log / Shell", { state: st });
    return t("單擊開啟詳情；右鍵更多動作");
  }
  if (kind === "registry" || kind === "harbor") return t("單擊開啟詳情；右鍵更多動作");
  if (kind === "kubernetes") {
    const k = parseObjKind(objKind);
    return k?.state ? t("{state} · 單擊開啟；右鍵更多動作", { state: k.state }) : t("單擊開啟詳情；右鍵更多動作");
  }
  return null;
}
