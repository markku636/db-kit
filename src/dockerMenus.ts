// Docker 連線樹的右鍵選單（物件層）。回傳結構與 App.tsx 的 MenuNode 相同（結構型別相容），
// 由 App 的 tableMenuNodes 直接回傳。動作本身在 dockerActions.ts（與詳情分頁共用）。
import { create } from "zustand";
import { api, type ConnectionConfig } from "./api";
import type { DockerContainerAction } from "./dockerTypes";
import { stateFromObjKind } from "./dockerModel";
import {
  containerActionLabel, createDbConnectionFromContainer, removeContainer, removeImage, removeNetwork, removeVolume,
  renameContainer, runContainerAction, tagImage,
} from "./dockerActions";
import { copyToClipboard, toast, uiConfirm, uiPrompt } from "./ui";
import { pullRef, registryHost } from "./registryModel";
import { useDockerPullRequest } from "./connPrefill";
import { t } from "./i18n";

export type DockerMenuNode =
  | { kind: "item"; label: string; onClick: () => void; danger?: boolean }
  | { kind: "sep" }
  | { kind: "sub"; label: string; children: DockerMenuNode[] };

export type ContainerSub = "info" | "logs" | "shell" | "stats" | "top";

/** 「開到某個子頁」的請求（右鍵「Log…」「Shell…」→ 開分頁後由 DockerContainerView 消費）。 */
export const useContainerSub = create<{
  req: Record<string, { sub: ContainerSub; nonce: number }>;
  request: (connId: string, name: string, sub: ContainerSub) => void;
  consume: (key: string) => void;
}>((set) => ({
  req: {},
  request: (connId, name, sub) =>
    set((s) => {
      const k = `${connId}:${name}`;
      return { req: { ...s.req, [k]: { sub, nonce: (s.req[k]?.nonce ?? 0) + 1 } } };
    }),
  // 消費後刪掉：否則之後單擊開同一容器，會被很久以前的請求帶到 Log / Shell。
  consume: (key) =>
    set((s) => {
      if (!(key in s.req)) return s;
      const req = { ...s.req };
      delete req[key];
      return { req };
    }),
}));

const BUILTIN_NETWORKS = new Set(["bridge", "host", "none", "nat", "ingress", "docker_gwbridge"]);

export function dockerItemMenu(ctx: {
  conn: ConnectionConfig;
  db: string;
  name: string;
  objKind: string;
  readonly: boolean;
  open: () => void;
  refresh: () => void;
  pull: (image?: string) => void;
}): DockerMenuNode[] {
  const { conn, db, name, readonly } = ctx;
  const it = (label: string, onClick: () => void, danger?: boolean): DockerMenuNode => ({ kind: "item", label, onClick, danger });
  const sep: DockerMenuNode = { kind: "sep" };
  const after = (p: Promise<unknown>) => void p.then((ok) => { if (ok) ctx.refresh(); });
  const nodes: DockerMenuNode[] = [];

  if (db === "containers") {
    const st = stateFromObjKind(ctx.objKind) ?? "";
    const running = st === "running" || st === "restarting";
    const paused = st === "paused";
    const openSub = (sub: ContainerSub) => {
      ctx.open();
      useContainerSub.getState().request(conn.id, name, sub);
    };
    nodes.push(it(t("開啟"), ctx.open));
    nodes.push(it(t("Log…"), () => openSub("logs")));
    if (running && !readonly) nodes.push(it(t("Shell…"), () => openSub("shell")));
    if (running) nodes.push(it(t("資源用量…"), () => openSub("stats")));
    if (!readonly) {
      const acts: DockerContainerAction[] = running
        ? ["stop", "restart", "pause", "kill"]
        : paused
        ? ["unpause", "restart", "kill"]
        : ["start"];
      nodes.push(sep);
      for (const a of acts) nodes.push(it(containerActionLabel(a), () => after(runContainerAction(conn.id, name, a)), a === "kill"));
    }
    nodes.push(sep);
    nodes.push(it(t("建立資料庫連線…"), () => void createDbConnectionFromContainer(conn, name)));
    nodes.push(it(t("複製名稱"), () => copyToClipboard(name, t("已複製"))));
    if (!readonly) {
      nodes.push(sep);
      nodes.push(it(t("重新命名…"), () => after(renameContainer(conn.id, name))));
      nodes.push(it(t("刪除…"), () => after(removeContainer(conn.id, name, running || paused)), true));
    }
  } else if (db === "images") {
    nodes.push(it(t("開啟"), ctx.open));
    nodes.push(it(t("複製名稱"), () => copyToClipboard(name, t("已複製"))));
    if (!readonly) {
      nodes.push(sep);
      if (ctx.objKind !== "image-dangling") nodes.push(it(t("重新拉取…"), () => ctx.pull(name)));
      nodes.push(it(t("加上 tag…"), () => after(tagImage(conn.id, name))));
      nodes.push(sep);
      nodes.push(it(t("刪除…"), () => after(removeImage(conn.id, name)), true));
    }
  } else if (db === "volumes") {
    nodes.push(it(t("開啟"), ctx.open));
    nodes.push(it(t("複製名稱"), () => copyToClipboard(name, t("已複製"))));
    if (!readonly) {
      nodes.push(sep);
      nodes.push(it(t("刪除…"), () => after(removeVolume(conn.id, name, [])), true));
    }
  } else if (db === "networks") {
    nodes.push(it(t("開啟"), ctx.open));
    nodes.push(it(t("複製名稱"), () => copyToClipboard(name, t("已複製"))));
    if (!readonly && !BUILTIN_NETWORKS.has(name)) {
      nodes.push(sep);
      nodes.push(it(t("刪除…"), () => after(removeNetwork(conn.id, name)), true));
    }
  }
  nodes.push(sep);
  nodes.push(it(t("重新整理"), ctx.refresh));
  return nodes;
}

/** 取 registry 主機（pull 參照用）。Registry 走 registryInfo、Harbor 走 harborOverview。 */
async function pullHost(conn: ConnectionConfig): Promise<string> {
  const base = conn.kind === "harbor" ? (await api.harborOverview(conn.id)).base_url : (await api.registryInfo(conn.id)).base_url;
  return registryHost(base);
}

/** Registry 的 tag 節點（db = repository、name = tag）。 */
export function registryItemMenu(ctx: {
  conn: ConnectionConfig;
  repo: string;
  tag: string;
  readonly: boolean;
  open: () => void;
  refresh: () => void;
}): DockerMenuNode[] {
  const { conn, repo, tag } = ctx;
  const it = (label: string, onClick: () => void, danger?: boolean): DockerMenuNode => ({ kind: "item", label, onClick, danger });
  const sep: DockerMenuNode = { kind: "sep" };
  const withRef = (fn: (ref: string) => void) => () =>
    void pullHost(conn).then((h) => fn(pullRef(h, repo, tag))).catch((e) => toast.error(e?.message ?? String(e)));
  const nodes: DockerMenuNode[] = [
    it(t("開啟"), ctx.open),
    it(t("複製 pull 指令"), withRef((ref) => copyToClipboard(`docker pull ${ref}`, t("已複製")))),
    it(t("拉到 Docker…"), withRef((ref) => useDockerPullRequest.getState().open({
      image: ref, user: conn.username, credConn: { id: conn.id, name: conn.name },
    }))),
  ];
  if (!ctx.readonly) {
    nodes.push(sep);
    nodes.push(it(t("刪除…"), async () => {
      const ok = await uiConfirm(
        t("刪除 manifest「{ref}」？指向同一 digest 的所有 tag 都會一併消失，且需等 registry 垃圾回收才會釋放空間。", { ref: `${repo}:${tag}` }),
        { title: t("刪除 manifest"), danger: true, confirmText: t("刪除") },
      );
      if (!ok) return;
      try {
        await api.registryDelete(conn.id, repo, tag);
        toast.success(t("已刪除 {name}", { name: `${repo}:${tag}` }));
        ctx.refresh();
      } catch (e: any) {
        toast.error(e?.message ?? String(e));
      }
    }, true));
  }
  nodes.push(sep, it(t("重新整理"), ctx.refresh));
  return nodes;
}

/** Harbor 的 repository 節點（db = project、name = repository）。 */
export function harborItemMenu(ctx: {
  conn: ConnectionConfig;
  project: string;
  repo: string;
  readonly: boolean;
  open: () => void;
  refresh: () => void;
}): DockerMenuNode[] {
  const { conn, project, repo } = ctx;
  const full = `${project}/${repo}`;
  const it = (label: string, onClick: () => void, danger?: boolean): DockerMenuNode => ({ kind: "item", label, onClick, danger });
  const sep: DockerMenuNode = { kind: "sep" };
  const nodes: DockerMenuNode[] = [
    it(t("開啟"), ctx.open),
    it(t("複製名稱"), () => copyToClipboard(full, t("已複製"))),
    it(t("複製 pull 指令（latest）"), () =>
      void pullHost(conn)
        .then((h) => copyToClipboard(`docker pull ${pullRef(h, full, "latest")}`, t("已複製")))
        .catch((e) => toast.error(e?.message ?? String(e)))),
  ];
  if (!ctx.readonly) {
    nodes.push(sep);
    nodes.push(it(t("刪除 repository…"), async () => {
      if (!(await uiConfirm(t("刪除 repository「{name}」與其中所有 artifact？此操作不可復原。", { name: full }), {
        title: t("刪除 repository"), danger: true, confirmText: t("繼續"),
      }))) return;
      const typed = await uiPrompt(t("請輸入 repository 名稱以確認刪除"), { placeholder: repo });
      if (typed === null) return;
      if (typed.trim() !== repo) {
        toast.error(t("輸入不符，已取消"));
        return;
      }
      try {
        await api.harborDeleteRepository(conn.id, project, repo);
        toast.success(t("已刪除 {name}", { name: full }));
        ctx.refresh();
      } catch (e: any) {
        toast.error(e?.message ?? String(e));
      }
    }, true));
  }
  nodes.push(sep, it(t("重新整理"), ctx.refresh));
  return nodes;
}
