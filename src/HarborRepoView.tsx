// Harbor repository 分頁：artifact 清單（tag、大小、推送時間、平台、弱點掃描摘要），
// 可觸發掃描、看弱點明細、刪 tag / artifact / 整個 repository、複製 pull 指令或直接拉到 Docker。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, Copy, Download, Package, RefreshCw, ShieldAlert, ShieldCheck, Trash2, X,
} from "lucide-react";
import { api } from "./api";
import type { HarborArtifact, HarborVulnReport } from "./registryTypes";
import { pullRef, registryHost, scanInProgress, scanSummary, severityTone, shortDigest } from "./registryModel";
import { fmtBytes, fmtIso } from "./dockerModel";
import { ErrorLine, MiniTable, InfoSection } from "./dockerUi";
import { Badge, Button, EmptyState, IconButton, Spinner } from "./ui/index";
import { copyToClipboard, toast, uiConfirm, uiPrompt } from "./ui";
import { useDockerPullRequest } from "./connPrefill";
import { useStore } from "./store";
import { useT } from "./i18n";

const PAGE_SIZE = 25;

export default function HarborRepoView({ connId, project, repo }: { connId: string; project: string; repo: string }) {
  const t = useT();
  const conn = useStore((s) => s.connections.find((c) => c.id === connId));
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const requestTreeReload = useStore((s) => s.requestTreeReload);
  const [items, setItems] = useState<HarborArtifact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [host, setHost] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [gone, setGone] = useState(false);
  const [vuln, setVuln] = useState<{ digest: string; report: HarborVulnReport | null; err: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.harborArtifacts(connId, project, repo, page, PAGE_SIZE);
      if (!alive.current) return;
      setItems(r.items);
      setTotal(r.total >= 0 ? r.total : r.items.length);
      setErr(null);
      setGone(false);
      if (!host) {
        const o = await api.harborOverview(connId).catch(() => null);
        if (o && alive.current) setHost(registryHost(o.base_url));
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/404|NOT_FOUND/i.test(msg)) setGone(true);
      if (alive.current) setErr(msg);
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, project, repo, page]);

  useEffect(() => { void load(); }, [load]);

  // 有掃描在跑就每 3 秒刷新一次。
  useEffect(() => {
    if (!items.some((a) => scanInProgress(a.scan))) return;
    const id = window.setTimeout(() => void load(), 3000);
    return () => window.clearTimeout(id);
  }, [items, load]);

  const fullRepo = `${project}/${repo}`;
  const refOf = (a: HarborArtifact) => a.tags[0]?.name ?? a.digest;

  const scan = async (a: HarborArtifact) => {
    try {
      await api.harborScan(connId, project, repo, a.digest);
      toast.success(t("已送出掃描：{ref}", { ref: shortDigest(a.digest) }));
      void load();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  const openVuln = async (a: HarborArtifact) => {
    setVuln({ digest: a.digest, report: null, err: null });
    try {
      const r = await api.harborVulnerabilities(connId, project, repo, a.digest);
      if (alive.current) setVuln({ digest: a.digest, report: r, err: null });
    } catch (e: any) {
      if (alive.current) setVuln({ digest: a.digest, report: null, err: e?.message ?? String(e) });
    }
  };

  const delArtifact = async (a: HarborArtifact) => {
    const tags = a.tags.map((x) => x.name).join(", ");
    const ok = await uiConfirm(
      tags
        ? t("刪除 artifact {digest}？它的 tag（{tags}）會一併刪除。", { digest: shortDigest(a.digest), tags })
        : t("刪除 artifact {digest}？", { digest: shortDigest(a.digest) }),
      { title: t("刪除 artifact"), danger: true, confirmText: t("刪除") },
    );
    if (!ok) return;
    try {
      await api.harborDeleteArtifact(connId, project, repo, a.digest);
      toast.success(t("已刪除 {name}", { name: shortDigest(a.digest) }));
      void load();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  const delTag = async (a: HarborArtifact, tag: string) => {
    if (!(await uiConfirm(t("移除 tag「{tag}」？artifact 本身保留。", { tag }), { danger: true, confirmText: t("移除") }))) return;
    try {
      await api.harborDeleteTag(connId, project, repo, a.digest, tag);
      toast.success(t("已移除 tag {tag}", { tag }));
      void load();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  const delRepo = async () => {
    if (!(await uiConfirm(t("刪除 repository「{name}」與其中所有 artifact？此操作不可復原。", { name: fullRepo }), {
      title: t("刪除 repository"), danger: true, confirmText: t("繼續"),
    }))) return;
    const typed = await uiPrompt(t("請輸入 repository 名稱以確認刪除"), { placeholder: repo });
    if (typed === null) return;
    if (typed.trim() !== repo) {
      toast.error(t("輸入不符，已取消"));
      return;
    }
    try {
      await api.harborDeleteRepository(connId, project, repo);
      toast.success(t("已刪除 {name}", { name: fullRepo }));
      requestTreeReload(connId, project);
      setGone(true);
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  const pullTo = (a: HarborArtifact) => {
    if (!host) return;
    useDockerPullRequest.getState().open({
      image: pullRef(host, fullRepo, refOf(a)),
      user: conn?.username,
      credConn: conn ? { id: conn.id, name: conn.name } : null,
    });
  };

  if (gone) return <EmptyState icon={Package} title={t("「{name}」已不存在", { name: fullRepo })} hint={t("可能已被刪除；請重新整理連線樹。")} />;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-fg/10 bg-bar flex-wrap">
        <Package size={14} className="text-fg/40" />
        <span className="text-xs mono text-fg/70 truncate">{fullRepo}</span>
        <Badge>{t("{n} 個 artifact", { n: total })}</Badge>
        <div className="ml-auto flex items-center gap-1">
          <IconButton icon={ChevronLeft} label={t("上一頁")} disabled={page <= 1} onClick={() => setPage((p) => p - 1)} />
          <span className="text-xs text-fg/50 tabular-nums">{page} / {pages}</span>
          <IconButton icon={ChevronRight} label={t("下一頁")} disabled={page >= pages} onClick={() => setPage((p) => p + 1)} />
          <Button size="sm" variant="ghost" icon={RefreshCw} loading={loading} onClick={() => void load()}>{t("重新整理")}</Button>
          {!readonly && <Button size="sm" variant="danger" icon={Trash2} onClick={() => void delRepo()}>{t("刪除 repository")}</Button>}
        </div>
      </div>
      <ErrorLine text={err} />
      <div className="flex-1 min-h-0 overflow-auto">
        {loading && items.length === 0 ? <div className="flex justify-center p-6"><Spinner /></div> : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-app">
              <tr className="text-left text-fg/40 border-b border-fg/10">
                <th className="px-3 py-1.5 font-normal">{t("Tag")}</th>
                <th className="px-2 py-1.5 font-normal">Digest</th>
                <th className="px-2 py-1.5 font-normal">{t("平台")}</th>
                <th className="px-2 py-1.5 font-normal text-right">{t("大小")}</th>
                <th className="px-2 py-1.5 font-normal">{t("推送時間")}</th>
                <th className="px-2 py-1.5 font-normal">{t("弱點")}</th>
                <th className="px-2 py-1.5 font-normal" />
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.digest} className="border-b border-fg/5 hover:bg-fg/[0.03] align-top">
                  <td className="px-3 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {a.tags.length === 0 && <span className="text-fg/30">{t("（無 tag）")}</span>}
                      {a.tags.map((tg) => (
                        <span key={tg.name} className="inline-flex items-center gap-0.5 px-1.5 rounded bg-fg/8 mono">
                          {tg.name}
                          {tg.immutable && <span title={t("不可變")} className="text-warning">•</span>}
                          {!readonly && !tg.immutable && (
                            <button type="button" className="text-fg/30 hover:text-danger" title={t("移除 tag")} onClick={() => void delTag(a, tg.name)}>
                              <X size={10} />
                            </button>
                          )}
                        </span>
                      ))}
                      {a.labels.map((l) => (
                        <span key={l.name} className="px-1.5 rounded text-[10px]" style={{ background: `${l.color || "#888"}33`, color: l.color || undefined }}>{l.name}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 mono text-fg/60">
                    <button type="button" className="hover:underline" title={a.digest} onClick={() => copyToClipboard(a.digest, t("已複製"))}>{shortDigest(a.digest)}</button>
                  </td>
                  <td className="px-2 py-1.5 text-fg/60 whitespace-nowrap">
                    {a.references > 0 ? t("多平台 · {n}", { n: a.references }) : a.os ? `${a.os}/${a.arch}` : a.kind}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtBytes(a.size)}</td>
                  <td className="px-2 py-1.5 text-fg/60 whitespace-nowrap">{fmtIso(a.push_time)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <ScanCell a={a} onOpen={() => void openVuln(a)} />
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap text-right">
                    <IconButton icon={ShieldCheck} label={t("掃描弱點")} disabled={scanInProgress(a.scan)} onClick={() => void scan(a)} />
                    {host && <IconButton icon={Copy} label={t("複製 pull 指令")} onClick={() => copyToClipboard(`docker pull ${pullRef(host, fullRepo, refOf(a))}`, t("已複製"))} />}
                    {host && <IconButton icon={Download} label={t("拉到 Docker…")} onClick={() => pullTo(a)} />}
                    {!readonly && <IconButton icon={Trash2} label={t("刪除 artifact")} onClick={() => void delArtifact(a)} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && items.length === 0 && !err && <EmptyState compact icon={Package} title={t("這個 repository 沒有 artifact")} />}

        {vuln && (
          <div className="p-3 border-t border-fg/10">
            <InfoSection
              title={
                vuln.report
                  ? t("弱點：{digest}（{scanner}，{n} 筆）", { digest: shortDigest(vuln.digest), scanner: vuln.report.scanner || "—", n: vuln.report.items.length })
                  : t("弱點：{digest}", { digest: shortDigest(vuln.digest) })
              }
              right={<IconButton icon={X} label={t("關閉")} onClick={() => setVuln(null)} />}
            >
              {vuln.err && <ErrorLine text={vuln.err} />}
              {!vuln.report && !vuln.err && <div className="flex justify-center p-4"><Spinner /></div>}
              {vuln.report && (
                <MiniTable
                  head={[t("嚴重度"), "CVE", t("套件"), t("版本"), t("修正版本"), "CVSS"]}
                  rows={vuln.report.items.map((v) => [
                    <Badge tone={severityTone(v.severity)}>{v.severity}</Badge>,
                    v.links[0]
                      ? <button type="button" className="mono hover:underline text-accent" title={v.description} onClick={() => void api.openExternal(v.links[0])}>{v.id}</button>
                      : <span className="mono" title={v.description}>{v.id}</span>,
                    <span className="mono">{v.package}</span>,
                    <span className="mono text-fg/60">{v.version}</span>,
                    <span className={`mono ${v.fix_version ? "text-success" : "text-fg/30"}`}>{v.fix_version || "—"}</span>,
                    v.cvss ? v.cvss.toFixed(1) : "",
                  ])}
                  empty={t("沒有弱點")}
                />
              )}
            </InfoSection>
          </div>
        )}
      </div>
    </div>
  );
}

function ScanCell({ a, onOpen }: { a: HarborArtifact; onOpen: () => void }) {
  const t = useT();
  const s = a.scan;
  if (!s || s.status === "" || s.status === "NotScanned") return <span className="text-fg/30">{t("未掃描")}</span>;
  if (scanInProgress(s)) return <span className="text-info">{t("掃描中 {p}%", { p: s.complete_percent })}</span>;
  if (s.status === "Error") return <Badge tone="danger">{t("掃描失敗")}</Badge>;
  const sum = scanSummary(s);
  return (
    <button type="button" onClick={onOpen} className="inline-flex items-center gap-1 hover:underline" title={t("看弱點明細")}>
      {s.total > 0 ? <ShieldAlert size={12} className="text-danger" /> : <ShieldCheck size={12} className="text-success" />}
      <Badge tone={s.total > 0 ? severityTone(s.severity) : "success"}>{s.total > 0 ? s.severity : t("無弱點")}</Badge>
      {sum && <span className="mono text-fg/50">{sum}</span>}
      {s.fixable > 0 && <span className="text-fg/40">{t("可修 {n}", { n: s.fixable })}</span>}
    </button>
  );
}
