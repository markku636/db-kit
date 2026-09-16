import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Copy, Play, Send, ShieldAlert } from "lucide-react";
import type { SyncStatement } from "./api";
import { useStore } from "./store";
import { copyToClipboard } from "./ui";
import { Button, Icon, Modal } from "./ui/index";
import { buildSyncScript, splitStatements } from "./compareModel";
import { useT } from "./i18n";

export interface StatementOutcome { index: number; ok: boolean; error?: string }

/**
 * 同步腳本面板：語句清單（安全 / 破壞性分組、可逐句排除）、複製 / 送到查詢編輯器 / 直接執行。
 * 直接執行前有巢狀確認框；含破壞性語句時必須另外勾「我了解」；目標連線為唯讀時停用。
 */
export default function SyncScriptPanel({ statements, skipped = [], header, dstConnId, dstLabel, onSend, onExecute, disabledReason }: {
  statements: SyncStatement[];
  skipped?: string[];
  header: string;
  /** 目標連線（快照目標為 null → 不能執行）。 */
  dstConnId: string | null;
  dstLabel: string;
  onSend?: (sql: string) => void;
  /** 執行選取的語句；回每句結果。undefined → 隱藏「直接執行」。 */
  onExecute?: (stmts: SyncStatement[]) => Promise<StatementOutcome[]>;
  disabledReason?: string;
}) {
  const t = useT();
  const readonly = useStore((s) => (dstConnId ? s.readonlyConns[dstConnId] === true : false));
  const [includeDestructive, setIncludeDestructive] = useState(false);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<StatementOutcome[] | null>(null);

  // 語句清單換了（重新比對）→ 排除集與結果作廢。
  useEffect(() => { setExcluded(new Set()); setOutcomes(null); }, [statements]);

  const { safe, destructive } = useMemo(() => splitStatements(statements), [statements]);
  const selected = useMemo(
    () => statements.map((s, i) => ({ s, i })).filter(({ s, i }) => !excluded.has(i) && (includeDestructive || !s.destructive)),
    [statements, excluded, includeDestructive],
  );
  const script = useMemo(() => buildSyncScript(selected.map((x) => x.s), header), [selected, header]);
  const hasDestructiveSelected = selected.some((x) => x.s.destructive);
  const toggle = (i: number) => setExcluded((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });

  const execReason = disabledReason ?? (!dstConnId ? t("目標為快照檔，無法執行") : readonly ? t("目標連線為唯讀，無法執行") : undefined);

  const run = async () => {
    if (!onExecute) return;
    setConfirm(false);
    setBusy(true);
    setOutcomes(null);
    setProgress({ done: 0, total: selected.length });
    try {
      // onExecute 回的 index 是「選取清單」的位置，映回原始 statements 索引才對得上清單列。
      const res = await onExecute(selected.map((x) => x.s));
      setOutcomes(res.map((o) => ({ ...o, index: selected[o.index]?.i ?? o.index })));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  const okCount = outcomes?.filter((o) => o.ok).length ?? 0;
  const failCount = outcomes ? outcomes.length - okCount : 0;

  const Item = ({ s, i }: { s: SyncStatement; i: number }) => {
    const on = !excluded.has(i) && (includeDestructive || !s.destructive);
    const o = outcomes?.find((x) => x.index === i);
    return (
      <label className={`flex items-start gap-2 px-2 py-1 text-[11px] hover:bg-fg/5 cursor-pointer ${on ? "" : "opacity-50"}`}>
        <input type="checkbox" className="mt-0.5" checked={on} disabled={s.destructive && !includeDestructive} onChange={() => toggle(i)} />
        <span className={`shrink-0 w-[7.5rem] truncate ${s.destructive ? "text-red-300" : "text-fg/50"}`} title={s.object}>{s.kind} · {s.object}</span>
        <span className="mono text-fg/75 whitespace-pre-wrap break-all flex-1">{s.sql}{s.note && <span className="block text-amber-300/80">-- {s.note}</span>}</span>
        {o && <span className={`shrink-0 ${o.ok ? "text-emerald-400" : "text-red-400"}`} title={o.error}>{o.ok ? "✓" : "✗"}</span>}
      </label>
    );
  };

  if (statements.length === 0 && skipped.length === 0) {
    return <div className="text-xs text-fg/40 px-1">{t("無需同步。")}</div>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-fg/60">{t("同步語句 {n} 句", { n: statements.length })}</span>
        {destructive.length > 0 && (
          <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-red-300">
            <input type="checkbox" checked={includeDestructive} onChange={(e) => setIncludeDestructive(e.target.checked)} />
            <Icon icon={ShieldAlert} size={12} />{t("包含破壞性語句（{n}）", { n: destructive.length })}
          </label>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="sm" icon={Copy} disabled={!selected.length} onClick={() => copyToClipboard(script, t("已複製同步 SQL"))}>{t("複製 SQL")}</Button>
          {onSend && <Button size="sm" icon={Send} disabled={!selected.length || !dstConnId} onClick={() => onSend(script)}>{t("送到查詢編輯器")}</Button>}
          {onExecute && (
            <Button size="sm" variant={hasDestructiveSelected ? "danger" : "primary"} icon={Play} loading={busy}
              disabled={!selected.length || !!execReason || busy} title={execReason} onClick={() => { setAck(false); setConfirm(true); }}>
              {busy && progress ? t("執行中 {done}/{total}", { done: progress.done, total: progress.total }) : t("直接執行")}
            </Button>
          )}
        </span>
      </div>
      {execReason && onExecute && <div className="text-[11px] text-amber-400">{execReason}</div>}
      <div className="max-h-60 overflow-auto rounded border border-fg/10 bg-app/40 divide-y divide-fg/5">
        {safe.length > 0 && statements.map((s, i) => (!s.destructive ? <Item key={i} s={s} i={i} /> : null))}
        {destructive.length > 0 && (
          <>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-red-300/80 bg-red-500/5 flex items-center gap-1"><Icon icon={AlertTriangle} size={11} />{t("破壞性（DROP / 改型別 / 加 NOT NULL）")}</div>
            {statements.map((s, i) => (s.destructive ? <Item key={i} s={s} i={i} /> : null))}
          </>
        )}
      </div>
      {skipped.length > 0 && (
        <div className="text-[11px] text-amber-300/80">
          <div>{t("以下變更無法自動產生語句，請手動處理：")}</div>
          <ul className="list-disc pl-4 max-h-24 overflow-auto">{skipped.map((s) => <li key={s}>{s}</li>)}</ul>
        </div>
      )}
      {outcomes && (
        <div className={`text-xs ${failCount ? "text-red-300" : "text-emerald-400"}`}>
          {failCount ? t("執行完成：{ok} 句成功，{fail} 句失敗", { ok: okCount, fail: failCount }) : t("已成功執行 {ok} 句", { ok: okCount })}
          {failCount > 0 && (
            <ul className="mt-1 mono text-[11px] text-red-300/80 max-h-24 overflow-auto list-disc pl-4">
              {outcomes.filter((o) => !o.ok).map((o) => <li key={o.index}>{statements[o.index]?.object}：{o.error}</li>)}
            </ul>
          )}
        </div>
      )}

      {confirm && (
        <Modal size="sm" noMaximize danger={hasDestructiveSelected} zClass="z-[105]" onClose={() => setConfirm(false)} title={t("在目標執行同步")}
          footer={<>
            <Button variant="secondary" onClick={() => setConfirm(false)}>{t("取消")}</Button>
            <Button variant={hasDestructiveSelected ? "dangerSolid" : "primary"} disabled={hasDestructiveSelected && !ack} onClick={run}>
              {t("執行 {n} 句", { n: selected.length })}
            </Button>
          </>}>
          <div className="space-y-3 text-sm">
            <div>{t("將在「{dst}」執行 {n} 句語句（{d} 句為破壞性）。此動作直接修改目標資料庫。", { dst: dstLabel, n: selected.length, d: selected.filter((x) => x.s.destructive).length })}</div>
            {hasDestructiveSelected && (
              <label className="flex items-start gap-2 cursor-pointer select-none text-red-300">
                <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>{t("我了解這會刪除目標的物件 / 資料，且無法復原。")}</span>
              </label>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
