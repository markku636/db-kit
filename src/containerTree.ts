// 容器類連線（Docker / Registry / Harbor）在側欄連線樹的呈現：database 層的標籤與圖示、
// 物件層（容器 / 映像 / tag / repository…）的圖示與色調。App.tsx 只呼叫這裡，不逐 kind 寫 JSX。
import { Box, Container, FolderGit2, HardDrive, Layers, Network, Package, Tag, type LucideIcon } from "lucide-react";
import type { DbKind } from "./api";
import { stateFromObjKind } from "./dockerModel";
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
  return null;
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
  return null;
}
