import { useEffect, useRef, useState } from "react";
import { api, onAgentStream, type AgentEvent, type AgentProvider, type AgentStatus } from "./api";
import { Button, Select } from "./ui/index";
import Icon from "./ui/Icon";
import { Sparkles, X, StopCircle, ClipboardCopy, RotateCw, CornerDownLeft, AlertTriangle } from "lucide-react";
import { useT } from "./i18n";
import { extractFirstCodeBlock } from "./nlPrompt";
import { copyToClipboard } from "./ui";
import { baseUrlOf, CLAUDE_MODELS, isApiProvider, PROVIDERS, providerMeta, useAiProvider } from "./aiProvider";
import { currentSystemPrompt } from "./aiSkills";

// 破壞性語句偵測（套用前警示）：DROP/TRUNCATE/ALTER，或無 WHERE 的 DELETE/UPDATE。
const DESTRUCTIVE = /\b(drop|truncate|alter)\b/i;
function isDestructive(code: string): boolean {
  if (DESTRUCTIVE.test(code)) return true;
  const noWhere = /\b(delete\s+from|update)\b/i.test(code) && !/\bwhere\b/i.test(code);
  return noWhere;
}

// 無 code block 時的整段 SQL fallback 判定。
const SQL_LEAD = /^\s*(select|insert|update|delete|create|alter|drop|truncate|with|explain)\b/i;

export interface NlQueryBarProps {
  open: boolean;
  onClose: () => void;
  /** 截取語言 + 預覽提示："sql"（SqlEditor）或 "json"（ES DSL）。 */
  lang: "sql" | "json";
  /** 宿主注入的 prompt 組裝（含 schema / mapping）。 */
  buildPrompt: (nl: string) => Promise<string>;
  /** 套用到編輯器（QueryPane：存歷史 + 填入；ES：setDsl）。 */
  onApply: (code: string) => void;
  /** 執行失敗時可「帶錯誤重試」：前一版語句 + 錯誤訊息回送重生成。 */
  lastError?: { message: string; sql: string } | null;
}

export default function NlQueryBar({ open, onClose, lang, buildPrompt, onApply, lastError }: NlQueryBarProps) {
  const t = useT();
  const [nl, setNl] = useState("");
  // 供應商與右側助手面板共用同一個偏好（aiProvider store）；模型各記一個，別名不能互餵。
  const provider = useAiProvider((s) => s.provider);
  const setProvider = useAiProvider((s) => s.setProvider);
  // 模型與 Base URL 與助手面板共用同一份設定（aiProvider store）。
  const models = useAiProvider((s) => s.models);
  const setModels = useAiProvider((s) => s.setModel);
  const baseUrls = useAiProvider((s) => s.baseUrls);
  const model = models[provider] || "";
  const setModel = (v: string) => setModels(provider, v);
  const baseUrl = baseUrlOf(provider, baseUrls);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [preview, setPreview] = useState(""); // 串流原文
  const [statement, setStatement] = useState<string | null>(null); // 截取後的語句
  const [noStatement, setNoStatement] = useState(false);
  const reqIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const detect = async () => {
    setDetecting(true);
    try {
      setStatus(await api.agentDetect(provider, baseUrl || null));
    } finally {
      setDetecting(false);
    }
  };

  // 首次展開時偵測 CLI，並聚焦輸入。
  useEffect(() => {
    if (!open) return;
    if (!status) void detect();
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 換供應商就重測一次（狀態清空避免沿用上一支 CLI 的結果）。
  useEffect(() => {
    setStatus(null);
    if (open) void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, baseUrl]);

  useEffect(() => () => { unlistenRef.current?.(); }, []);

  const notReady = !!status && (!status.installed || !status.logged_in);
  const meta = providerMeta(provider);

  const finalize = (text: string) => {
    const code = extractFirstCodeBlock(text, [lang]);
    if (code) { setStatement(code); setNoStatement(false); return; }
    // 無 code block：SQL 情境若整段像 SQL 就整段當語句。
    if (lang === "sql" && SQL_LEAD.test(text.trim())) { setStatement(text.trim()); setNoStatement(false); return; }
    setStatement(null);
    setNoStatement(true);
  };

  const runGenerate = async (prompt: string) => {
    setGenerating(true);
    setPreview("");
    setStatement(null);
    setNoStatement(false);
    const reqId = crypto.randomUUID();
    reqIdRef.current = reqId;
    let acc = "";
    try {
      const un = await onAgentStream(reqId, (e: AgentEvent) => {
        switch (e.kind) {
          case "text":
            if (e.text) { acc += e.text; setPreview(acc); }
            break;
          case "result":
            if (e.text && !acc) { acc = e.text; setPreview(acc); }
            if (e.is_error) void detect();
            break;
          case "error":
            acc += (acc ? "\n\n" : "") + `⚠ ${e.text ?? t("發生錯誤")}`;
            setPreview(acc);
            break;
          case "done":
            setGenerating(false);
            finalize(acc);
            unlistenRef.current?.();
            unlistenRef.current = null;
            break;
        }
      });
      unlistenRef.current = un;
      await api.agentSend({
        reqId,
        prompt,
        sessionId: null,
        model,
        mode: "generate",
        provider,
        baseUrl: baseUrl || null,
        systemPrompt: currentSystemPrompt(false),
      });
    } catch (err: any) {
      setGenerating(false);
      setPreview(`⚠ ${err?.message ?? t("發生錯誤")}`);
    }
  };

  const generate = async () => {
    const text = nl.trim();
    if (!text || generating || notReady) return;
    try {
      const prompt = await buildPrompt(text);
      await runGenerate(prompt);
    } catch (err: any) {
      setPreview(`⚠ ${err?.message ?? t("發生錯誤")}`);
    }
  };

  const retryWithError = async () => {
    if (!lastError || generating) return;
    const text = nl.trim() || t("（沿用上一個需求）");
    try {
      const base = await buildPrompt(text);
      const prompt = `${base}\n\n【前一版語句執行失敗，請修正後重新產生】\n語句：\n${lastError.sql}\n錯誤：${lastError.message}`;
      await runGenerate(prompt);
    } catch (err: any) {
      setPreview(`⚠ ${err?.message ?? t("發生錯誤")}`);
    }
  };

  const stop = () => {
    if (reqIdRef.current) void api.agentCancel(reqIdRef.current);
    setGenerating(false);
  };

  if (!open) return null;

  return (
    <div className="border-t border-fg/10 bg-well/40 px-3 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <Icon icon={Sparkles} size={14} className="text-accent shrink-0" />
        <span className="text-xs font-medium text-fg/70">{t("AI 生成查詢")}</span>
        <Select selectSize="sm" value={provider} onChange={(e) => setProvider(e.target.value as AgentProvider)}
          title={t("要用哪個供應商生成（CLI 走你的訂閱登入，API 走你自己的端點與金鑰）")} className="w-32 ml-1">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </Select>
        {provider === "claude" ? (
          <Select selectSize="sm" value={model} onChange={(e) => setModel(e.target.value)} className="w-28">
            {CLAUDE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.value ? m.label : t("預設模型")}</option>)}
          </Select>
        ) : (
          <input value={model} onChange={(e) => setModel(e.target.value)}
            placeholder={isApiProvider(provider) ? t("模型名稱") : t("預設模型")}
            title={isApiProvider(provider)
              ? t("這個端點的模型名稱（可在 AI 設定裡從端點抓清單）")
              : t("留白用 codex 自己的預設模型；也可填模型名稱，如 gpt-5-codex")}
            className="w-28 h-7 bg-inset border border-fg/10 rounded px-2 text-xs outline-none focus:border-accent" />
        )}
        <button type="button" onClick={onClose} title={t("關閉")} className="ml-auto text-fg/40 hover:text-fg/70">
          <Icon icon={X} size={15} />
        </button>
      </div>

      {notReady ? (
        <div className="text-[11px] text-amber-200/90 bg-amber-500/10 rounded px-2 py-1.5 leading-relaxed">
          {isApiProvider(provider) ? (
            !status!.installed
              ? t("尚未設定 {name} 的 Base URL。", { name: meta.label })
              : t("{name} 還沒有 API 金鑰（地端端點可以不用）。", { name: meta.label })
          ) : !status!.installed ? (
            t("找不到 {cli} CLI。請先安裝 {name}（{how}）。", { cli: meta.cli, name: meta.label, how: meta.install })
          ) : (
            t("尚未登入 {name}。請在終端機執行 {cmd} 並用你的訂閱帳號登入。", { name: meta.label, cmd: meta.loginCmd })
          )}
          <button type="button" onClick={detect} disabled={detecting} className="ml-1 underline hover:text-amber-100 disabled:opacity-50">
            {detecting ? t("偵測中…") : t("重新偵測")}
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            rows={2}
            disabled={generating}
            placeholder={t("用自然語言描述你想查什麼…（Enter 生成、Shift+Enter 換行、Esc 收合）")}
            className="flex-1 resize-none bg-inset border border-fg/10 rounded px-2 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-60"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void generate(); }
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
          />
          <div className="flex flex-col gap-1">
            {generating ? (
              <Button variant="secondary" icon={StopCircle} onClick={stop}>{t("停止")}</Button>
            ) : (
              <Button variant="primary" icon={CornerDownLeft} onClick={() => void generate()} disabled={!nl.trim()}>{t("生成")}</Button>
            )}
            {lastError && !generating && (
              <Button variant="secondary" icon={AlertTriangle} onClick={() => void retryWithError()}>{t("帶錯誤重試")}</Button>
            )}
          </div>
        </div>
      )}

      {(generating || preview) && !notReady && (
        <div className="space-y-1.5">
          <pre className="max-h-40 overflow-auto bg-inset border border-fg/10 rounded p-2 text-xs mono whitespace-pre-wrap break-words text-fg/80">
            {statement ?? preview}{generating && <span className="animate-pulse">▋</span>}
          </pre>
          {statement && isDestructive(statement) && (
            <div className="flex items-center gap-1 text-[11px] text-danger">
              <Icon icon={AlertTriangle} size={12} />{t("含破壞性操作，套用前請確認")}
            </div>
          )}
          {statement && !generating && (
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => { onApply(statement); onClose(); }}>{t("套用到編輯器")}</Button>
              <Button variant="secondary" icon={ClipboardCopy} onClick={() => void copyToClipboard(statement)}>{t("複製")}</Button>
              <Button variant="ghost" icon={RotateCw} onClick={() => void generate()}>{t("重新生成")}</Button>
            </div>
          )}
          {noStatement && !generating && (
            <div className="text-[11px] text-fg/50">{t("未取得語句，請重試或改寫描述")}</div>
          )}
        </div>
      )}
    </div>
  );
}
