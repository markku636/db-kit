// Docker 操作（確認對話框 + 呼叫後端 + toast）：側欄右鍵選單與各詳情分頁的動作列共用同一份。
// 回傳 true = 已執行成功（呼叫端據此重新整理），false = 使用者取消或失敗（已 toast）。
import { api, type ConnectionConfig } from "./api";
import type { DockerContainerAction, DockerPruneTarget } from "./dockerTypes";
import { guessDbFromContainer } from "./dockerDbGuess";
import { useConnPrefill } from "./connPrefill";
import { fmtBytes } from "./dockerModel";
import { t } from "./i18n";
import { toast, uiConfirm, uiPrompt } from "./ui";

function errText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

const ACTION_LABEL: Record<DockerContainerAction, string> = {
  start: "啟動",
  stop: "停止",
  restart: "重新啟動",
  pause: "暫停",
  unpause: "繼續",
  kill: "強制終止",
};

export function containerActionLabel(a: DockerContainerAction): string {
  return t(ACTION_LABEL[a]);
}

/** 啟停類操作。stop / restart / kill 會中斷服務，先確認。 */
export async function runContainerAction(connId: string, name: string, action: DockerContainerAction): Promise<boolean> {
  if (action === "stop" || action === "restart" || action === "kill") {
    const ok = await uiConfirm(
      t("確定要{action}容器「{name}」？正在處理的連線會中斷。", { action: containerActionLabel(action), name }),
      { danger: action === "kill", confirmText: containerActionLabel(action) },
    );
    if (!ok) return false;
  }
  try {
    await api.dockerContainerAction(connId, name, action);
    toast.success(t("已{action}容器 {name}", { action: containerActionLabel(action), name }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

/** 刪除容器：執行中的要強制；可一併刪匿名 volume。 */
export async function removeContainer(connId: string, name: string, running: boolean): Promise<boolean> {
  const ok = await uiConfirm(
    running
      ? t("容器「{name}」正在執行，將強制停止並刪除。此操作不可復原。", { name })
      : t("確定刪除容器「{name}」？此操作不可復原。", { name }),
    { title: t("刪除容器"), danger: true, confirmText: t("刪除") },
  );
  if (!ok) return false;
  try {
    await api.dockerContainerRemove(connId, name, running, false);
    toast.success(t("已刪除容器 {name}", { name }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

export async function renameContainer(connId: string, name: string): Promise<string | null> {
  const next = await uiPrompt(t("新的容器名稱"), { defaultValue: name, confirmText: t("重新命名") });
  if (next === null || !next.trim() || next.trim() === name) return null;
  try {
    await api.dockerContainerRename(connId, name, next.trim());
    toast.success(t("已重新命名為 {name}", { name: next.trim() }));
    return next.trim();
  } catch (e) {
    toast.error(errText(e));
    return null;
  }
}

/** 刪除映像（或移除一個 tag）。被容器使用時 daemon 會拒絕，再問一次是否強制。 */
export async function removeImage(connId: string, reference: string): Promise<boolean> {
  const ok = await uiConfirm(
    t("確定刪除映像「{name}」？若還有其他 tag 指向同一映像，只會移除這個 tag。", { name: reference }),
    { title: t("刪除映像"), danger: true, confirmText: t("刪除") },
  );
  if (!ok) return false;
  try {
    await api.dockerImageRemove(connId, reference, false);
    toast.success(t("已刪除映像 {name}", { name: reference }));
    return true;
  } catch (e) {
    const msg = errText(e);
    if (!/conflict|being used|in use|must be forced/i.test(msg)) {
      toast.error(msg);
      return false;
    }
    const force = await uiConfirm(
      t("映像「{name}」仍被容器使用或有多個參照：{msg}\n\n要強制刪除嗎？", { name: reference, msg }),
      { title: t("強制刪除映像"), danger: true, confirmText: t("強制刪除") },
    );
    if (!force) return false;
    try {
      await api.dockerImageRemove(connId, reference, true);
      toast.success(t("已刪除映像 {name}", { name: reference }));
      return true;
    } catch (e2) {
      toast.error(errText(e2));
      return false;
    }
  }
}

export async function tagImage(connId: string, source: string): Promise<boolean> {
  const target = await uiPrompt(t("新的映像名稱（repo:tag）"), { defaultValue: source, confirmText: t("加上 tag") });
  if (target === null || !target.trim() || target.trim() === source) return false;
  const v = target.trim();
  const slash = v.lastIndexOf("/");
  const colon = v.lastIndexOf(":");
  const [repo, tag] = colon > slash ? [v.slice(0, colon), v.slice(colon + 1)] : [v, "latest"];
  try {
    await api.dockerImageTag(connId, source, repo, tag);
    toast.success(t("已加上 tag {name}", { name: `${repo}:${tag}` }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

export async function removeVolume(connId: string, name: string, usedBy: string[]): Promise<boolean> {
  const ok = await uiConfirm(
    usedBy.length
      ? t("volume「{name}」仍被容器使用（{list}），刪除會失敗；請先刪除這些容器。仍要嘗試嗎？", { name, list: usedBy.join(", ") })
      : t("確定刪除 volume「{name}」？裡面的資料會永久消失。", { name }),
    { title: t("刪除 volume"), danger: true, confirmText: t("刪除") },
  );
  if (!ok) return false;
  try {
    await api.dockerVolumeRemove(connId, name, false);
    toast.success(t("已刪除 volume {name}", { name }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

export async function removeNetwork(connId: string, name: string): Promise<boolean> {
  const ok = await uiConfirm(t("確定刪除網路「{name}」？", { name }), {
    title: t("刪除網路"),
    danger: true,
    confirmText: t("刪除"),
  });
  if (!ok) return false;
  try {
    await api.dockerNetworkRemove(connId, name);
    toast.success(t("已刪除網路 {name}", { name }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

const PRUNE_TEXT: Record<DockerPruneTarget, string> = {
  containers: "刪除所有已停止的容器",
  images: "刪除懸空（無 tag）的映像",
  volumes: "刪除沒有容器使用的匿名 volume",
  networks: "刪除沒有容器使用的自訂網路",
  build: "清除建置快取",
};

export function pruneLabel(target: DockerPruneTarget, all: boolean): string {
  if (all && target === "images") return t("刪除所有沒有容器使用的映像");
  if (all && target === "volumes") return t("刪除所有沒有容器使用的 volume（含具名）");
  return t(PRUNE_TEXT[target]);
}

/** 清理（prune）。會刪資料的（volumes / images all）要輸入 prune 二次確認。 */
export async function prune(connId: string, target: DockerPruneTarget, all: boolean): Promise<boolean> {
  const label = pruneLabel(target, all);
  const ok = await uiConfirm(t("{label}？此操作不可復原。", { label }), {
    title: t("清理"),
    danger: true,
    confirmText: t("繼續"),
  });
  if (!ok) return false;
  if (target === "volumes" || (target === "images" && all)) {
    const typed = await uiPrompt(t("請輸入 prune 以確認"), { placeholder: "prune" });
    if (typed === null) return false;
    if (typed.trim() !== "prune") {
      toast.error(t("輸入不符，已取消"));
      return false;
    }
  }
  try {
    const r = await api.dockerPrune(connId, target, all);
    toast.success(t("已清理 {n} 項，釋放 {size}", { n: r.deleted, size: fmtBytes(r.space_reclaimed) }));
    return true;
  } catch (e) {
    toast.error(errText(e));
    return false;
  }
}

/**
 * 從容器建資料庫連線：inspect → 推測類型 / 埠 / 帳密 → 開預填好的新增連線對話框（使用者確認後才存）。
 * `conn` 為 Docker 連線本身（決定主機位址，並沿用其 SSH 通道設定）。
 */
export async function createDbConnectionFromContainer(conn: ConnectionConfig, name: string): Promise<void> {
  try {
    const d = await api.dockerContainerInspect(conn.id, name);
    const g = guessDbFromContainer(d, conn);
    if (!g) {
      toast.info(t("認不出容器「{name}」是哪種資料庫（映像 {image}）", { name, image: d.image }));
      return;
    }
    if (!g.published) {
      toast.info(t("容器沒有發布資料庫埠，改填容器 IP {ip}；只有 Docker 跑在本機 Linux 時才連得到", { ip: g.host }));
    }
    useConnPrefill.getState().open(g.prefill);
  } catch (e) {
    toast.error(errText(e));
  }
}
