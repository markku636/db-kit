// Registry tag 分頁：manifest（digest / 大小 / 格式）、多平台清單（點選看該平台）、layers、映像 config。
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Copy, Download, RefreshCw, Tag, Trash2 } from "lucide-react";
import { api } from "./api";
import type { RegistryManifest } from "./registryTypes";
import { pullRef, registryHost, shortDigest } from "./registryModel";
import { fmtBytes, fmtIso } from "./dockerModel";
import { EnvTable, ErrorLine, InfoRow, InfoSection, JsonBlock, MiniTable } from "./dockerUi";
import { Badge, Button, EmptyState, Spinner } from "./ui/index";
import { copyToClipboard, toast, uiConfirm } from "./ui";
import { useDockerPullRequest } from "./connPrefill";
import { useStore } from "./store";
import { useT } from "./i18n";

export default function RegistryTagView({ connId, repo, tag }: { connId: string; repo: string; tag: string }) {
  const t = useT();
  const conn = useStore((s) => s.connections.find((c) => c.id === connId));
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const requestTreeReload = useStore((s) => s.requestTreeReload);
  // 目前看的參照：tag 本身，或多平台清單裡點進去的平台 digest。
  const [ref, setRef] = useState(tag);
  const [m, setM] = useState<RegistryManifest | null>(null);
  const [host, setHost] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [man, info] = await Promise.all([api.registryManifest(connId, repo, ref), host ? null : api.registryInfo(connId)]);
      setM(man);
      if (info) setHost(registryHost(info.base_url));
      setErr(null);
      setGone(false);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/404|MANIFEST_UNKNOWN/i.test(msg)) setGone(true);
      setErr(msg);
    } finally {
      setBusy(false);
    }
    // host 只抓一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, repo, ref]);

  useEffect(() => { void load(); }, [load]);

  const pull = host ? pullRef(host, repo, ref === tag ? tag : ref) : "";

  const del = async () => {
    const ok = await uiConfirm(
      t("刪除 manifest「{ref}」？指向同一 digest 的所有 tag 都會一併消失，且需等 registry 垃圾回收才會釋放空間。", { ref: `${repo}:${tag}` }),
      { title: t("刪除 manifest"), danger: true, confirmText: t("刪除") },
    );
    if (!ok) return;
    try {
      await api.registryDelete(connId, repo, m?.digest || tag);
      toast.success(t("已刪除 {name}", { name: `${repo}:${tag}` }));
      requestTreeReload(connId, repo);
      setGone(true);
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  if (gone) {
    return <EmptyState icon={Tag} title={t("「{name}」已不存在", { name: `${repo}:${tag}` })} hint={t("可能已被刪除；請重新整理連線樹。")} />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-fg/10 bg-bar flex-wrap">
        {ref !== tag && <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={() => setRef(tag)}>{t("回到 {tag}", { tag })}</Button>}
        <Tag size={14} className="text-fg/40" />
        <span className="text-xs mono text-fg/70 truncate">{repo}:{tag}{ref !== tag ? ` → ${shortDigest(ref)}` : ""}</span>
        {m && <Badge>{fmtBytes(m.size)}</Badge>}
        {m?.is_index && <Badge tone="info">{t("多平台 · {n}", { n: m.platforms.length })}</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy} onClick={() => void load()}>{t("重新整理")}</Button>
          {pull && <Button size="sm" variant="ghost" icon={Copy} onClick={() => copyToClipboard(`docker pull ${pull}`, t("已複製"))}>{t("複製 pull 指令")}</Button>}
          {pull && (
            <Button size="sm" variant="ghost" icon={Download}
              onClick={() => useDockerPullRequest.getState().open({
                image: pull, user: conn?.username, credConn: conn ? { id: conn.id, name: conn.name } : null,
              })}>
              {t("拉到 Docker…")}
            </Button>
          )}
          {!readonly && ref === tag && m && (
            <Button size="sm" variant="danger" icon={Trash2} onClick={() => void del()}>{t("刪除")}</Button>
          )}
        </div>
      </div>
      <ErrorLine text={err} />
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-4">
        {!m ? !err && <div className="flex justify-center p-6"><Spinner /></div> : (
          <>
            <InfoSection title={t("Manifest")}>
              <InfoRow label="Digest" mono>
                <button type="button" className="hover:underline text-left" title={t("點一下複製")} onClick={() => copyToClipboard(m.digest, t("已複製"))}>{m.digest || "—"}</button>
              </InfoRow>
              <InfoRow label={t("格式")} mono>{m.media_type}</InfoRow>
              <InfoRow label={t("大小")}>{fmtBytes(m.size)}{!m.is_index && t("（{n} 層）", { n: m.layers.length })}</InfoRow>
              {pull && <InfoRow label={t("Pull 參照")} mono>{pull}</InfoRow>}
            </InfoSection>

            {m.is_index && (
              <InfoSection title={t("平台（{n}）", { n: m.platforms.length })}>
                <MiniTable
                  head={[t("平台"), "Digest", t("大小")]}
                  rows={m.platforms.map((p) => [
                    <button type="button" className="hover:underline text-accent" onClick={() => setRef(p.digest)}>
                      {p.os}/{p.arch}{p.variant ? `/${p.variant}` : ""}
                    </button>,
                    <span className="mono text-fg/60">{shortDigest(p.digest)}</span>,
                    fmtBytes(p.size),
                  ])}
                />
              </InfoSection>
            )}

            {m.config && (
              <>
                <InfoSection title={t("映像設定")}>
                  <InfoRow label={t("建立時間")}>{fmtIso(m.config.created)}</InfoRow>
                  <InfoRow label={t("平台")}>{m.config.os}/{m.config.arch}</InfoRow>
                  <InfoRow label="Entrypoint" mono>{m.config.entrypoint.join(" ") || "—"}</InfoRow>
                  <InfoRow label="Cmd" mono>{m.config.cmd.join(" ") || "—"}</InfoRow>
                  <InfoRow label={t("開放埠")} mono>{m.config.exposed_ports.join(", ") || "—"}</InfoRow>
                  {m.config.working_dir && <InfoRow label={t("工作目錄")} mono>{m.config.working_dir}</InfoRow>}
                  {m.config.user && <InfoRow label={t("使用者")} mono>{m.config.user}</InfoRow>}
                </InfoSection>
                <EnvTable env={m.config.env} />
                {Object.keys(m.config.labels).length > 0 && (
                  <InfoSection title={t("標籤（{n}）", { n: Object.keys(m.config.labels).length })}>
                    <MiniTable head={[t("鍵"), t("值")]} rows={Object.entries(m.config.labels).map(([k, v]) => [<span className="mono text-fg/70">{k}</span>, <span className="mono">{v}</span>])} />
                  </InfoSection>
                )}
                {m.config.history.length > 0 && (
                  <InfoSection title={t("建置歷史（{n}）", { n: m.config.history.length })}>
                    <MiniTable head={[t("指令")]} rows={m.config.history.map((h) => [<span className="mono text-fg/70">{h.replace(/^\/bin\/sh -c (#\(nop\) )?/, "")}</span>])} />
                  </InfoSection>
                )}
              </>
            )}

            {!m.is_index && (
              <InfoSection title={t("Layers（{n}）", { n: m.layers.length })}>
                <MiniTable
                  head={["Digest", t("大小"), t("格式")]}
                  rows={m.layers.map((l) => [<span className="mono">{shortDigest(l.digest)}</span>, fmtBytes(l.size), <span className="mono text-fg/50">{l.media_type}</span>])}
                />
              </InfoSection>
            )}

            <JsonBlock title="manifest JSON" json={m.raw} />
          </>
        )}
      </div>
    </div>
  );
}
