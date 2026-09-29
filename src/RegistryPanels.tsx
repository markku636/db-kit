// Registry / Harbor 的資訊面板（連線 / 專案右鍵開啟）：Registry 端點資訊、Harbor 總覽、Harbor 專案資訊。
import { useEffect, useState } from "react";
import { Anchor, FolderGit2, Package } from "lucide-react";
import { api } from "./api";
import type { HarborOverview, HarborProject, RegistryInfo } from "./registryTypes";
import { fmtBytes, fmtIso } from "./dockerModel";
import { InfoRow, InfoSection, MiniTable, StatTile } from "./dockerUi";
import { Badge, Button, Modal, Spinner } from "./ui/index";
import { useT } from "./i18n";

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fn().then((d) => { if (alive) setData(d); }).catch((e) => { if (alive) setErr(e?.message ?? String(e)); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, err };
}

function Body({ err, loading, children }: { err: string | null; loading: boolean; children: React.ReactNode }) {
  if (err) return <div className="text-sm text-danger break-all">{err}</div>;
  if (loading) return <div className="flex justify-center p-6"><Spinner /></div>;
  return <>{children}</>;
}

export function RegistryInfoPanel({ connId, connName, onClose }: { connId: string; connName: string; onClose: () => void }) {
  const t = useT();
  const { data, err } = useLoad<RegistryInfo>(() => api.registryInfo(connId), [connId]);
  return (
    <Modal onClose={onClose} title={t("端點資訊 · {name}", { name: connName })} icon={Package} size="md"
      footer={<Button onClick={onClose}>{t("關閉")}</Button>}>
      <Body err={err} loading={!data}>
        {data && (
          <InfoSection title="Registry">
            <InfoRow label={t("網址")} mono>{data.base_url}</InfoRow>
            <InfoRow label="API">{data.api_version || "—"}</InfoRow>
            <InfoRow label={t("認證")}>{data.auth === "bearer" ? "Bearer token" : data.auth === "basic" ? "Basic" : t("匿名")}</InfoRow>
            <InfoRow label="_catalog">
              {data.catalog ? <Badge tone="success">{t("可用")}</Badge> : <Badge tone="warning">{t("不開放（需在連線設定填 Repository 清單）")}</Badge>}
            </InfoRow>
          </InfoSection>
        )}
      </Body>
    </Modal>
  );
}

export function HarborOverviewPanel({ connId, connName, onClose }: { connId: string; connName: string; onClose: () => void }) {
  const t = useT();
  const { data: o, err } = useLoad<HarborOverview>(() => api.harborOverview(connId), [connId]);
  return (
    <Modal onClose={onClose} title={t("總覽 · {name}", { name: connName })} icon={Anchor} size="lg"
      footer={<Button onClick={onClose}>{t("關閉")}</Button>}>
      <Body err={err} loading={!o}>
        {o && (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-2">
              <StatTile label={t("私有專案")} value={o.private_projects} />
              <StatTile label={t("公開專案")} value={o.public_projects} />
              <StatTile label={t("私有 repository")} value={o.private_repos} />
              <StatTile label={t("公開 repository")} value={o.public_repos} />
            </div>
            <InfoSection title="Harbor">
              <InfoRow label={t("版本")}>{o.harbor_version || "—"}</InfoRow>
              <InfoRow label={t("網址")} mono>{o.base_url}</InfoRow>
              <InfoRow label={t("認證模式")}>{o.auth_mode || "—"}</InfoRow>
              <InfoRow label={t("目前使用者")}>{o.user ? `${o.user}${o.is_admin ? t("（系統管理員）") : ""}` : t("匿名")}</InfoRow>
              <InfoRow label={t("總儲存用量")}>{o.storage_used >= 0 ? fmtBytes(o.storage_used) : t("（需系統管理員權限）")}</InfoRow>
              <InfoRow label={t("健康狀態")}>
                <Badge tone={o.health === "healthy" ? "success" : o.health ? "danger" : "neutral"}>{o.health || "—"}</Badge>
              </InfoRow>
            </InfoSection>
            {o.components.length > 0 && (
              <InfoSection title={t("元件")}>
                <MiniTable
                  head={[t("元件"), t("狀態"), t("錯誤")]}
                  rows={o.components.map((c) => [c.name, <Badge tone={c.status === "healthy" ? "success" : "danger"}>{c.status}</Badge>, <span className="text-danger">{c.error}</span>])}
                />
              </InfoSection>
            )}
          </div>
        )}
      </Body>
    </Modal>
  );
}

export function HarborProjectPanel({ connId, project, onClose }: { connId: string; project: string; onClose: () => void }) {
  const t = useT();
  const { data: p, err } = useLoad<HarborProject>(() => api.harborProject(connId, project), [connId, project]);
  const yes = (b: boolean) => (b ? <Badge tone="success">{t("開")}</Badge> : <Badge>{t("關")}</Badge>);
  return (
    <Modal onClose={onClose} title={t("專案 · {name}", { name: project })} icon={FolderGit2} size="md"
      footer={<Button onClick={onClose}>{t("關閉")}</Button>}>
      <Body err={err} loading={!p}>
        {p && (
          <InfoSection title={p.registry_name ? t("Proxy cache（上游 {name}）", { name: p.registry_name }) : t("專案")}>
            <InfoRow label={t("存取")}>{p.public ? <Badge tone="info">{t("公開")}</Badge> : <Badge>{t("私有")}</Badge>}</InfoRow>
            <InfoRow label="Repository">{p.repo_count}</InfoRow>
            <InfoRow label={t("擁有者")}>{p.owner || "—"}</InfoRow>
            <InfoRow label={t("建立時間")}>{fmtIso(p.creation_time)}</InfoRow>
            <InfoRow label={t("推送時自動掃描")}>{yes(p.auto_scan)}</InfoRow>
            <InfoRow label={t("阻擋有弱點的映像")}>{yes(p.prevent_vul)}{p.prevent_vul && p.severity ? t("（{sev} 以上）", { sev: p.severity }) : ""}</InfoRow>
            <InfoRow label={t("配額")}>
              {p.quota_used >= 0 ? fmtBytes(p.quota_used) : "—"} / {p.quota_hard > 0 ? fmtBytes(p.quota_hard) : t("無限制")}
            </InfoRow>
          </InfoSection>
        )}
      </Body>
    </Modal>
  );
}
