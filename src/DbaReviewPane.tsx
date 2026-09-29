import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ClipboardEdit, Copy, Database, FileCode2, Library, Loader2, MessageSquare, Pencil, Sparkles, Square, Users } from "lucide-react";
import type { DbKind } from "./api";
import { ToolCalls } from "./AssistantPanel";
import { useAssistant } from "./assistant";
import { entryTitle, personas, useAiLibrary } from "./aiLibrary";
import { defaultDbaPersona, panelPersonas } from "./dbaReview";
import { useT } from "./i18n";
import { parseBlocks, TextBlock } from "./MarkdownLite";
import { useStore } from "./store";
import { copyToClipboard, toast } from "./ui";
import { Badge, Button, Icon, Modal, Segmented, Textarea, type BadgeTone } from "./ui/index";
import lazyOverlay from "./ui/lazyOverlay";
import { combinedReviewText, useDbaReview, type DbaReviewer, type DbaRun } from "./useDbaReview";
import { stripVerdictLine, type Verdict } from "./verdict";

const AiLibraryDialog = lazyOverlay(() => import("./AiLibraryDialog"));

export interface DbaPrepared {
  /** 使用者訊息（範本 + 上下文 + 結論契約），所有審查者共用。 */
  prompt: string;
  reviewers: DbaReviewer[];
}

export interface DbaReviewState {
  text: string;
  verdict: Verdict | null;
  running: boolean;
}

export type VerdictLabels = Record<Verdict, string>;

export function VerdictBadge({ verdict, labels, prefix }: { verdict: Verdict; labels?: VerdictLabels; prefix?: string }) {
  const t = useT();
  const tone: Record<Verdict, BadgeTone> = { go: "success", caution: "warning", stop: "danger" };
  const l = labels ?? { go: t("可以執行"), caution: t("注意風險後再執行"), stop: t("不建議執行") };
  return (
    <Badge tone={tone[verdict]} dot>
      {prefix ? `${prefix}：` : ""}
      {l[verdict]}
    </Badge>
  );
}

/**
 * DBA 審查面板：挑人設（多選 = 會審）→ 送出 → 各自串流、工具呼叫稽核、結論徽章；修正 SQL 一鍵走差異預覽。
 *
 * 三個入口共用（編輯器 SQL、審查並執行、資料表結構），差別只在 `prepare` 怎麼組提示：編輯器與結構在前端
 * 用資源庫範本組，審查並執行由後端組（與 `dbk run` 同一份）。
 */
export default function DbaReviewPane({
  prepare,
  connId,
  database,
  kind,
  prod,
  autoStartKey = null,
  onApplySql,
  onChange,
  emptyHint,
  disabled = false,
  verdictLabels,
  followUpLabel,
  initialPersonas,
}: {
  /** 依選定人設組好提示與審查者；回 null 表示這次不送（例如沒有 SQL）。 */
  prepare: (personas: string[]) => Promise<DbaPrepared | null>;
  connId: string | null;
  database: string | null;
  kind: DbKind | null;
  prod: boolean;
  /** 值改變時自動送出一次（null = 不自動）。 */
  autoStartKey?: string | number | null;
  onApplySql?: (sql: string) => void;
  onChange?: (s: DbaReviewState) => void;
  emptyHint?: ReactNode;
  disabled?: boolean;
  verdictLabels?: VerdictLabels;
  followUpLabel?: string;
  /** 預設勾選的人設（例如結構審查預設資料模型架構師）；省略 = 依正式環境與否取設定的預設。 */
  initialPersonas?: string[];
}) {
  const t = useT();
  const snap = useAiLibrary((s) => s.snapshot);
  const dbaList = useMemo(() => personas("dba", snap), [snap]);
  const [selected, setSelected] = useState<string[]>(() => (initialPersonas?.length ? initialPersonas : [defaultDbaPersona(prod)]));
  const [tab, setTab] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [editing, setEditing] = useState<DbaPrepared | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const lastPrompt = useRef<DbaPrepared | null>(null);
  const review = useDbaReview();

  // 正式環境旗標晚一步才知道（審查並執行要等後端分析）時，預設人設跟著換——但使用者動過就不動。
  const touched = useRef(!!initialPersonas?.length);
  useEffect(() => {
    if (!touched.current) setSelected([defaultDbaPersona(prod)]);
  }, [prod, snap]);

  const text = combinedReviewText(review.runs);
  useEffect(() => {
    onChange?.({ text, verdict: review.combined, running: review.running });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, review.combined, review.running]);

  const send = async (prepared: DbaPrepared) => {
    lastPrompt.current = prepared;
    setTab(0);
    await review.start({ prompt: prepared.prompt, reviewers: prepared.reviewers, connId, database });
  };

  const start = async (edit = false) => {
    if (!selected.length || preparing) return;
    setPreparing(true);
    try {
      const p = await prepare(selected);
      if (!p || !p.reviewers.length) return;
      if (edit) setEditing(p);
      else await send(p);
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setPreparing(false);
    }
  };

  useEffect(() => {
    if (autoStartKey != null && !disabled) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartKey]);

  const toggle = (name: string) => {
    touched.current = true;
    setSelected((cur) => (cur.includes(name) ? (cur.length > 1 ? cur.filter((x) => x !== name) : cur) : [...cur, name]));
  };

  const followUp = () => {
    const p = lastPrompt.current;
    if (!text.trim()) return;
    useAssistant.getState().ask(followUpLabel ?? t("我對這份 DBA 審查有後續問題。請先用三句話總結結論與最關鍵的風險，再等我追問。"), {
      send: true,
      extraContext: [p ? `${t("【審查任務】")}\n${p.prompt}` : "", `${t("【DBA 審查結果】")}\n${text}`].filter(Boolean).join("\n\n"),
    });
  };

  const runs = review.runs;
  const current: DbaRun | undefined = runs[Math.min(tab, Math.max(0, runs.length - 1))];
  const busy = preparing || review.running;

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* 人設 + 動作 */}
      <div className="flex flex-wrap items-center gap-1.5 pb-2 border-b border-fg/10">
        <Icon icon={Users} size={13} className="text-fg/45" />
        {dbaList.map((e) => {
          const on = selected.includes(e.name);
          return (
            <button
              key={e.name}
              type="button"
              disabled={busy}
              onClick={() => toggle(e.name)}
              title={t("點選切換；選多位就是會審")}
              className={`inline-flex items-center gap-1 px-2 h-6 rounded text-[11px] border ${on ? "border-accent bg-accent/15 text-fg" : "border-fg/10 text-fg/55 hover:border-fg/25"}`}
            >
              {on && <Icon icon={Check} size={10} />}
              {entryTitle(e)}
            </button>
          );
        })}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            touched.current = true;
            setSelected(panelPersonas(prod));
          }}
          title={t("套用設定裡的會審陣容")}
        >
          {t("會審")}
        </Button>
        <Button size="sm" variant="ghost" icon={Library} onClick={() => setLibOpen(true)} title={t("在 AI 資源庫調整人設與範本")} />
        <div className="ml-auto flex items-center gap-1.5">
          {review.combined && <VerdictBadge verdict={review.combined} labels={verdictLabels} prefix={runs.length > 1 ? t("綜合") : undefined} />}
          {text.trim() && !review.running && (
            <Button size="sm" variant="ghost" icon={MessageSquare} onClick={followUp}>
              {t("在助手中追問")}
            </Button>
          )}
          {review.running ? (
            <Button size="sm" variant="danger" icon={Square} onClick={review.cancel}>
              {t("停止")}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" icon={Pencil} disabled={disabled || preparing} onClick={() => void start(true)} title={t("先看、改這次要送出的提示（只用這一次，不存檔）")}>
                {t("編輯本次提示")}
              </Button>
              <Button size="sm" variant="primary" icon={preparing ? Loader2 : Sparkles} disabled={disabled || preparing} onClick={() => void start()}>
                {runs.length ? t("重新審查") : selected.length > 1 ? t("會審（{n} 位）", { n: selected.length }) : t("DBA 審查")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 結果 */}
      <div className="flex-1 min-h-0 overflow-auto pt-2">
        {runs.length === 0 ? (
          <div className="text-xs text-fg/50 space-y-2 max-w-2xl">
            {emptyHint ?? <p>{t("選好 DBA 人設後按「DBA 審查」。可以選多位同時會審，綜合結論取最嚴格者。")}</p>}
            <p className="text-fg/40">
              {connId
                ? t("審查者可以自己呼叫唯讀資料庫工具（EXPLAIN、看結構與索引）驗證後再下結論；每次呼叫都會列在結果裡。")
                : t("目前沒有連線：審查者只能看這裡附上的內容，不能自己查資料庫。")}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.length > 1 && (
              <Segmented
                size="sm"
                value={String(tab)}
                onChange={(v) => setTab(Number(v))}
                options={runs.map((r, i) => ({
                  value: String(i),
                  label: (
                    <span className="inline-flex items-center gap-1">
                      {r.running || r.queued ? (
                        <Icon icon={Loader2} size={11} className="animate-spin" />
                      ) : (
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${r.verdict === "stop" ? "bg-danger" : r.verdict === "caution" ? "bg-warning" : r.verdict === "go" ? "bg-success" : "bg-fg/30"}`}
                        />
                      )}
                      {r.title}
                    </span>
                  ),
                }))}
              />
            )}
            {current && <RunView run={current} kind={kind} onApplySql={onApplySql} verdictLabels={verdictLabels} />}
          </div>
        )}
      </div>

      {editing && (
        <EditPromptDialog
          prepared={editing}
          onClose={() => setEditing(null)}
          onSend={(p) => {
            setEditing(null);
            void send(p);
          }}
        />
      )}
      {libOpen && <AiLibraryDialog open initialTab="agent" onClose={() => setLibOpen(false)} />}
    </div>
  );
}

function RunView({ run, kind, onApplySql, verdictLabels }: { run: DbaRun; kind: DbKind | null; onApplySql?: (sql: string) => void; verdictLabels?: VerdictLabels }) {
  const t = useT();
  const body = stripVerdictLine(run.text);
  const blocks = useMemo(() => parseBlocks(body), [body]);
  return (
    <div className="space-y-2 max-w-4xl">
      <div className="flex items-center gap-2 text-[11px] text-fg/50">
        {run.verdict && <VerdictBadge verdict={run.verdict} labels={verdictLabels} />}
        <Badge tone={run.mode === "dba" ? "info" : "neutral"}>
          <Icon icon={Database} size={10} />
          {run.mode === "dba" ? t("可查資料庫") : t("一次性審查")}
        </Badge>
        {run.queued && <span>{t("排隊中…")}</span>}
        {run.running && !run.text && (
          <span className="inline-flex items-center gap-1">
            <Icon icon={Loader2} size={11} className="animate-spin" />
            {run.tools.length ? t("查資料庫中…") : t("審查中…")}
          </span>
        )}
        {!run.running && run.text && !run.verdict && <span className="text-warning">{t("這份回覆第一行沒有結論（VERDICT），綜合結論以「注意風險」計")}</span>}
      </div>
      {run.error && <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger whitespace-pre-wrap">{run.error}</div>}
      <ToolCalls calls={run.tools} kind={kind} />
      {blocks.map((b, i) =>
        b.type === "code" ? (
          <div key={i} className="rounded border border-fg/10 overflow-hidden bg-well">
            <div className="flex flex-wrap items-center gap-1 px-2 py-1 bg-fg/5 text-[10px] text-fg/45">
              <span className="uppercase tracking-wide">{b.lang || "code"}</span>
              <span className="ml-auto" />
              {onApplySql && (!b.lang || b.lang.toLowerCase() === "sql") && (
                <button type="button" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded whitespace-nowrap hover:bg-fg/10 hover:text-fg" onClick={() => onApplySql(b.code)}>
                  <Icon icon={ClipboardEdit} size={11} />
                  {t("套用到編輯器（差異預覽）")}
                </button>
              )}
              {(!b.lang || b.lang.toLowerCase() === "sql") && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded whitespace-nowrap hover:bg-fg/10 hover:text-fg"
                  onClick={() => {
                    useStore.getState().requestQuery(b.code);
                    toast.success(t("已在查詢分頁開啟"));
                  }}
                >
                  <Icon icon={FileCode2} size={11} />
                  {t("在查詢分頁開啟")}
                </button>
              )}
              <button type="button" className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded whitespace-nowrap hover:bg-fg/10 hover:text-fg" onClick={() => void copyToClipboard(b.code)}>
                <Icon icon={Copy} size={11} />
                {t("複製")}
              </button>
            </div>
            <pre className="p-2 overflow-auto text-[12px] mono leading-relaxed">{b.code}</pre>
          </div>
        ) : (
          <TextBlock key={i} text={b.text} />
        ),
      )}
      {run.running && run.text && <Icon icon={Loader2} size={13} className="animate-spin text-fg/40" />}
    </div>
  );
}

/** 「編輯本次提示」：看得到、也改得到這一次要送出的完整提示（人設 + 任務），只用這一次、不存檔。 */
function EditPromptDialog({ prepared, onClose, onSend }: { prepared: DbaPrepared; onClose: () => void; onSend: (p: DbaPrepared) => void }) {
  const t = useT();
  const [prompt, setPrompt] = useState(prepared.prompt);
  const [systems, setSystems] = useState(prepared.reviewers.map((r) => r.system));
  const [who, setWho] = useState(0);
  return (
    <Modal
      open
      onClose={onClose}
      title={t("編輯本次提示")}
      icon={Pencil}
      size="xl"
      codeZoom
      footer={
        <div className="flex items-center gap-2 w-full">
          <span className="text-[11px] text-fg/45">{t("只用於這一次審查，不會改到資源庫裡的範本或人設。")}</span>
          <Button className="ml-auto" variant="ghost" onClick={onClose}>
            {t("取消")}
          </Button>
          <Button
            variant="primary"
            icon={Sparkles}
            onClick={() => onSend({ prompt, reviewers: prepared.reviewers.map((r, i) => ({ ...r, system: systems[i] })) })}
          >
            {t("送出")}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs text-fg/70">
            {t("人設（系統提示）")}
            {prepared.reviewers.length > 1 && (
              <Segmented size="sm" value={String(who)} onChange={(v) => setWho(Number(v))} options={prepared.reviewers.map((r, i) => ({ value: String(i), label: r.title }))} />
            )}
          </div>
          <Textarea
            rows={7}
            className="font-mono text-[12px]"
            value={systems[who]}
            onChange={(e) => setSystems((s) => s.map((x, i) => (i === who ? e.target.value : x)))}
          />
        </div>
        <div className="space-y-1">
          <div className="text-xs text-fg/70">{t("任務（使用者訊息）")}</div>
          <Textarea rows={18} className="font-mono text-[12px]" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}
