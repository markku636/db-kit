// 「SSH 操作紀錄」：看過去在各台主機上執行過的指令、檔案面板的動作（上傳 / 下載 / 刪除 / 改名 / 權限 / 存檔）、
// 連線與斷線。可依時間、主機、種類、關鍵字篩，匯出 CSV。紀錄由後端存（src-tauri/src/ssh/oplog.rs），
// 密碼不會進來（見 sshOpLog.ts）。開關與保留天數在「設定 → SSH 終端機」。
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Copy, FileDown, FolderOpen, History, RefreshCw, Trash2 } from "lucide-react";
import { api } from "./api";
import { t, useT } from "./i18n";
import { Badge, Button, EmptyState, IconButton, Input, Modal, Segmented, Select, Spinner } from "./ui/index";
import { copyToClipboard, pickSaveFile, toast, uiConfirm } from "./ui";
import { sessionLabel, useSshSessions } from "./sshSessions";
import { useSshOpLog } from "./sshOpLogStore";
import { defaultLogName } from "./sshSessionLog";
import {
  OP_KIND_GROUPS, entryHost, fmtTs, rangeFor, toCsv, type SshOpEntry, type SshOpKindGroup, type SshOpLogConfig,
} from "./sshOpLog";
import type { BadgeTone } from "./ui/index";

/** 一次最多載入幾筆（再多請縮小範圍）。 */
const LIMIT = 2000;

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function opKindLabel(kind: string): string {
  switch (kind) {
    case "connect": return t("連線");
    case "disconnect": return t("斷線");
    case "command": return t("指令");
    case "upload": return t("上傳");
    case "download": return t("下載");
    case "delete": return t("刪除");
    case "rename": return t("改名");
    case "mkdir": return t("建資料夾");
    case "chmod": return t("權限");
    case "save": return t("存檔");
    case "create": return t("新增檔案");
    default: return kind;
  }
}

function kindTone(kind: string): BadgeTone {
  if (kind === "command") return "accent";
  if (kind === "connect" || kind === "disconnect") return "neutral";
  if (kind === "delete") return "danger";
  return "info";
}

export function opSourceLabel(source: string): string {
  switch (source) {
    case "keyboard": return t("鍵盤");
    case "paste": return t("貼上");
    case "compose": return t("命令列");
    case "ai": return "AI";
    case "app": return "App";
    default: return source;
  }
}

export function opResultLabel(result: string): string {
  if (result === "ok") return t("成功");
  if (result === "cancelled") return t("已取消");
  return t("失敗");
}

/** 多個路徑（以換行分隔）→ 第一個 + 「等 N 個」。 */
function paths(detail: string): string {
  const list = detail.split("\n").filter(Boolean);
  if (list.length <= 1) return list[0] ?? "";
  return t("{first} 等 {n} 個", { first: list[0], n: list.length });
}

type RangeKey = "1" | "7" | "30" | "90" | "all";
type KindKey = "all" | SshOpKindGroup;

export default function SshOpLogDialog() {
  const open = useSshOpLog((s) => s.open);
  if (!open) return null;
  return createPortal(<Inner />, document.body);
}

function Inner() {
  const t = useT();
  const initial = useSshOpLog((s) => s.filter);
  const close = useSshOpLog((s) => s.close);
  const sessions = useSshSessions((s) => s.sessions);
  const [range, setRange] = useState<RangeKey>("7");
  const [kind, setKind] = useState<KindKey>("all");
  // 主機篩選：s:<已存主機 id> / h:<user@host> / ""（全部）
  const [host, setHost] = useState(() => (initial.sessionId ? `s:${initial.sessionId}` : initial.host ? `h:${initial.host}` : ""));
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [entries, setEntries] = useState<SshOpEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<SshOpLogConfig | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const h = window.setTimeout(() => setQDebounced(q), 250);
    return () => window.clearTimeout(h);
  }, [q]);

  useEffect(() => {
    void api.sshOplogConfig().then((i) => setConfig(i.config)).catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const { from, to } = rangeFor(range === "all" ? null : Number(range));
    void api.sshOplogQuery({
      from, to,
      kinds: kind === "all" ? [] : [...OP_KIND_GROUPS[kind]],
      session_id: host.startsWith("s:") ? host.slice(2) : null,
      host: host.startsWith("h:") ? host.slice(2) : "",
      text: qDebounced,
      limit: LIMIT,
    }).then((p) => {
      if (!alive) return;
      setEntries(p.entries);
      setMore(p.more);
      setError(null);
    }).catch((e) => {
      if (!alive) return;
      setEntries([]);
      setMore(false);
      setError(errMsg(e));
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [range, kind, host, qDebounced, tick]);

  const nameOf = useMemo(() => {
    const m = new Map(sessions.map((s) => [s.id, sessionLabel(s)]));
    return (e: SshOpEntry) => (e.session_id && m.get(e.session_id)) || entryHost(e);
  }, [sessions]);

  const hostOptions = useMemo(() => {
    const opts = sessions.map((s) => ({ value: `s:${s.id}`, label: sessionLabel(s) }));
    if (initial.host && !initial.sessionId) opts.unshift({ value: `h:${initial.host}`, label: initial.label || initial.host });
    // 開啟時指定的主機已經刪掉了：還是要列出來，選單才不會顯示成「全部主機」卻其實有篩。
    if (initial.sessionId && !sessions.some((s) => s.id === initial.sessionId)) {
      opts.unshift({ value: `s:${initial.sessionId}`, label: initial.label || initial.sessionId });
    }
    return opts;
  }, [sessions, initial]);

  const enable = async () => {
    try {
      const info = await api.sshOplogConfigSet({ enabled: true, retention_days: config?.retention_days ?? 90 });
      setConfig(info.config);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const exportCsv = async () => {
    if (!entries.length) return;
    const path = await pickSaveFile(defaultLogName("ssh-oplog", new Date(), "csv"), [{ name: "CSV", extensions: ["csv"] }]);
    if (!path) return;
    const csv = toCsv(entries, {
      header: [t("時間"), t("名稱"), t("主機"), t("協定"), t("類型"), t("內容"), t("目的地"), t("資料夾"), t("來源"), t("結果"), t("訊息")],
      kind: opKindLabel, result: opResultLabel, source: opSourceLabel,
    }, nameOf);
    try {
      await api.saveTextFile(path, csv);
      toast.success(t("已匯出 {n} 筆到 {path}", { n: entries.length, path }));
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const clearAll = async () => {
    const ok = await uiConfirm(t("刪除所有 SSH 操作紀錄？此操作不可復原。"), { title: t("清除操作紀錄"), danger: true, confirmText: t("全部刪除") });
    if (!ok) return;
    try {
      await api.sshOplogClear();
      setTick((n) => n + 1);
      toast.success(t("已清除 SSH 操作紀錄"));
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const copy = (text: string) => void copyToClipboard(text);

  return (
    <Modal open onClose={close} title={t("SSH 操作紀錄")} icon={History} size="xl" zClass="z-[105]" className="h-[80vh]"
      bodyClassName="flex flex-col min-h-0 p-0"
      footer={
        <>
          <span className="mr-auto text-xs text-fg/50" data-testid="ssh-oplog-count">
            {more ? t("顯示最近 {n} 筆（還有更多，請縮小範圍）", { n: entries.length }) : t("共 {n} 筆", { n: entries.length })}
          </span>
          <IconButton icon={FolderOpen} label={t("開啟紀錄所在的資料夾")} onClick={() => void api.sshOplogReveal().catch((e) => toast.error(errMsg(e)))} />
          <IconButton icon={Trash2} label={t("清除全部紀錄…")} onClick={() => void clearAll()} />
          <Button variant="secondary" icon={FileDown} disabled={!entries.length} onClick={() => void exportCsv()}>{t("匯出 CSV…")}</Button>
          <Button variant="primary" onClick={close}>{t("關閉")}</Button>
        </>
      }>
      <div data-testid="ssh-oplog" className="flex flex-col min-h-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-fg/10">
          <Select value={range} onChange={(e) => setRange(e.target.value as RangeKey)} aria-label={t("時間範圍")}>
            <option value="1">{t("今天")}</option>
            <option value="7">{t("最近 7 天")}</option>
            <option value="30">{t("最近 30 天")}</option>
            <option value="90">{t("最近 90 天")}</option>
            <option value="all">{t("全部")}</option>
          </Select>
          <Segmented ariaLabel={t("種類")} value={kind} onChange={setKind} options={[
            { value: "all", label: t("全部") },
            { value: "command", label: t("指令") },
            { value: "file", label: t("檔案") },
            { value: "conn", label: t("連線") },
          ]} />
          <Select value={host} onChange={(e) => setHost(e.target.value)} aria-label={t("主機")} className="max-w-[200px]">
            <option value="">{t("全部主機")}</option>
            {hostOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("搜尋指令、路徑…")} className="flex-1 min-w-[140px]"
            aria-label={t("搜尋")} />
          <IconButton icon={RefreshCw} label={t("重新整理")} onClick={() => setTick((n) => n + 1)} />
        </div>
        {config && !config.enabled && (
          <div className="flex items-center gap-2 px-4 py-2 text-xs bg-warning/10 text-warning border-b border-fg/10">
            <span className="flex-1">{t("操作紀錄已關閉，新的操作不會記下來。")}</span>
            <Button size="sm" variant="secondary" onClick={() => void enable()}>{t("開啟紀錄")}</Button>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-auto">
          {loading && !entries.length ? (
            <div className="flex justify-center p-10"><Spinner /></div>
          ) : error ? (
            <EmptyState compact icon={History} title={t("讀取操作紀錄失敗")} hint={error} />
          ) : !entries.length ? (
            <EmptyState compact icon={History} title={t("沒有符合的紀錄")}
              hint={t("在 SSH 終端機執行的指令、SFTP / FTP 的檔案動作、連線與斷線都會記在這裡；密碼不會被記下來。")} />
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 z-10 bg-inset text-fg/45">
                <tr className="text-left">
                  <th className="font-normal px-3 py-1.5 w-[140px]">{t("時間")}</th>
                  <th className="font-normal px-2 py-1.5 w-[160px]">{t("主機")}</th>
                  <th className="font-normal px-2 py-1.5 w-[84px]">{t("類型")}</th>
                  <th className="font-normal px-2 py-1.5">{t("內容")}</th>
                  <th className="font-normal px-3 py-1.5 w-[64px]">{t("結果")}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <Row key={`${e.ts}-${i}`} e={e} name={nameOf(e)} onCopy={copy} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Row({ e, name, onCopy }: { e: SshOpEntry; name: string; onCopy: (text: string) => void }) {
  const t = useT();
  const who = entryHost(e);
  const fileOp = e.kind !== "command" && e.kind !== "connect" && e.kind !== "disconnect";
  let content: ReactNode;
  let copyText = e.detail;
  if (e.kind === "command") {
    content = (
      <>
        <span className="mono whitespace-pre-wrap break-all text-fg/85">{e.detail}</span>
        {(e.cwd || (e.source && e.source !== "keyboard")) && (
          <span className="block text-[11px] text-fg/40 mt-0.5">
            {e.cwd && <span className="mono">{t("在 {dir}", { dir: e.cwd })}</span>}
            {e.cwd && e.source && e.source !== "keyboard" && " · "}
            {e.source && e.source !== "keyboard" && t("從{source}送出", { source: opSourceLabel(e.source) })}
          </span>
        )}
      </>
    );
  } else if (e.kind === "connect" || e.kind === "disconnect") {
    copyText = "";
    content = <span className="text-fg/60">{e.message || (e.kind === "connect" ? t("已連線（{proto}）", { proto: e.proto.toUpperCase() }) : "")}</span>;
  } else {
    const src = paths(e.detail);
    const arrow = e.kind === "chmod" ? t("{path} → {mode}", { path: src, mode: e.target ?? "" }) : e.target ? `${src} → ${e.target}` : src;
    copyText = e.detail;
    content = (
      <>
        <span className="mono break-all text-fg/85" title={e.detail}>{arrow}</span>
        {e.message && e.result === "ok" && <span className="block text-[11px] text-fg/40 mt-0.5">{e.message}</span>}
      </>
    );
  }
  return (
    <tr className="group border-t border-fg/5 align-top hover:bg-fg/[0.03]" data-testid="ssh-oplog-row" data-kind={e.kind}>
      <td className="px-3 py-1.5 mono text-fg/50 whitespace-nowrap">{fmtTs(e.ts)}</td>
      <td className="px-2 py-1.5 max-w-[160px]">
        <span className="block truncate text-fg/75" title={`${who} (${e.proto.toUpperCase()})`}>{name}</span>
        {name !== who && <span className="block truncate text-[11px] text-fg/35 mono">{who}</span>}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        <Badge tone={kindTone(e.kind)}>{opKindLabel(e.kind)}</Badge>
        {fileOp && <span className="ml-1 text-[10px] text-fg/35">{e.proto.toUpperCase()}</span>}
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-start gap-1">
          <div className="flex-1 min-w-0">{content}</div>
          {copyText && (
            <IconButton icon={Copy} label={t("複製")} box="w-5 h-5" iconSize={12} className="opacity-0 group-hover:opacity-100 shrink-0"
              onClick={() => onCopy(copyText)} />
          )}
        </div>
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">
        {e.result === "ok" ? (
          <span className="text-emerald-500">✓</span>
        ) : (
          <span className={e.result === "error" ? "text-danger" : "text-fg/45"} title={e.message ?? undefined}>
            {e.result === "error" ? `✗ ${t("失敗")}` : t("已取消")}
          </span>
        )}
      </td>
    </tr>
  );
}
