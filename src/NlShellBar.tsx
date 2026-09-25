// 「用自然語言產生指令」：SSH 終端機的 NL → shell 指令列（對標查詢分頁的 NlQueryBar）。
// 結果永遠只「放進指令列」給使用者看過再送，元件本身不會送任何東西進 shell。
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ClipboardCopy, CornerDownLeft, RotateCw, ShieldAlert, Sparkles, StopCircle, X } from "lucide-react";
import { api, type AgentProvider, type AgentStatus } from "./api";
import { Button, Select } from "./ui/index";
import Icon from "./ui/Icon";
import { copyToClipboard } from "./ui";
import { useLang, useT } from "./i18n";
import { baseUrlOf, CLAUDE_MODELS, isApiProvider, PROVIDERS, providerMeta, useAiProvider } from "./aiProvider";
import CliSetupHint from "./CliSetupHint";
import { useOneShotGenerate } from "./useOneShotGenerate";
import { buildNlShellPrompt, extractShellProposal, sshTerminalGuidance } from "./sshAiPrompts";
import { classifyShell } from "./shellGuard";
import type { TerminalSnapshot } from "./chatTypes";

export interface NlShellBarProps {
  snapshot: TerminalSnapshot | null;
  onClose: () => void;
  /** 把指令放進命令列輸入條（不送出）。 */
  onApply: (cmd: string) => void;
}

export default function NlShellBar({ snapshot, onClose, onApply }: NlShellBarProps) {
  const t = useT();
  const uiLang = useLang((s) => s.lang);
  const [nl, setNl] = useState("");
  const provider = useAiProvider((s) => s.provider);
  const setProvider = useAiProvider((s) => s.setProvider);
  const models = useAiProvider((s) => s.models);
  const setModels = useAiProvider((s) => s.setModel);
  const baseUrls = useAiProvider((s) => s.baseUrls);
  const model = models[provider] || "";
  const setModel = (v: string) => setModels(provider, v);
  const baseUrl = baseUrlOf(provider, baseUrls);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [detecting, setDetecting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const guidance = useMemo(() => sshTerminalGuidance(), []);
  const gen = useOneShotGenerate({ mode: "generate", systemPrompt: guidance });

  const detect = async () => {
    setDetecting(true);
    try { setStatus(await api.agentDetect(provider, baseUrl || null)); } finally { setDetecting(false); }
  };
  useEffect(() => {
    setStatus(null);
    void detect();
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, baseUrl]);

  const notReady = !!status && (!status.installed || !status.logged_in);
  const meta = providerMeta(provider);

  const proposal = !gen.running && gen.text ? extractShellProposal(gen.text) : null;
  const verdict = proposal ? classifyShell(proposal) : null;

  const generate = () => {
    const req = nl.trim();
    if (!req || gen.running) return;
    void gen.run(buildNlShellPrompt({ request: req, snapshot, uiLang }));
  };

  return (
    <div className="shrink-0 border-t border-fg/10 bg-panel px-2 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <Icon icon={Sparkles} size={14} className="text-accent shrink-0" />
        <span className="text-xs font-medium text-fg/70">{t("AI 產生指令")}</span>
        <Select selectSize="sm" value={provider} onChange={(e) => setProvider(e.target.value as AgentProvider)} className="w-32 ml-1">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </Select>
        {provider === "claude" ? (
          <Select selectSize="sm" value={model} onChange={(e) => setModel(e.target.value)} className="w-28">
            {CLAUDE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.value ? m.label : t("預設模型")}</option>)}
          </Select>
        ) : (
          <input value={model} onChange={(e) => setModel(e.target.value)}
            placeholder={isApiProvider(provider) ? t("模型名稱") : t("預設模型")}
            className="w-28 h-7 bg-inset border border-fg/10 rounded px-2 text-xs outline-none focus:border-accent" />
        )}
        <button type="button" onClick={onClose} title={t("關閉")} className="ml-auto text-fg/40 hover:text-fg/70">
          <Icon icon={X} size={15} />
        </button>
      </div>

      {notReady ? (
        <div className="text-[11px] text-amber-200/90 bg-amber-500/10 rounded px-2 py-1.5 leading-relaxed">
          {isApiProvider(provider) ? (
            <>
              {!status!.installed
                ? t("尚未設定 {name} 的 Base URL。", { name: meta.label })
                : t("{name} 還沒有 API 金鑰（地端端點可以不用）。", { name: meta.label })}
              <button type="button" onClick={detect} disabled={detecting} className="ml-1 underline hover:text-amber-100 disabled:opacity-50">
                {detecting ? t("偵測中…") : t("重新偵測")}
              </button>
            </>
          ) : (
            <CliSetupHint provider={provider} status={status!} detecting={detecting} onDetect={detect} />
          )}
        </div>
      ) : (
        <div className="flex gap-2">
          <textarea
            ref={inputRef}
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            rows={2}
            disabled={gen.running}
            placeholder={t("描述你想在這台主機做什麼…（Enter 生成、Shift+Enter 換行、Esc 收合）")}
            className="flex-1 resize-none bg-inset border border-fg/10 rounded px-2 py-1.5 text-sm outline-none focus:border-accent disabled:opacity-60"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); generate(); }
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
          />
          <div className="flex flex-col gap-1">
            {gen.running ? (
              <Button variant="secondary" icon={StopCircle} onClick={gen.cancel}>{t("停止")}</Button>
            ) : (
              <Button variant="primary" icon={CornerDownLeft} onClick={generate} disabled={!nl.trim()}>{t("生成")}</Button>
            )}
          </div>
        </div>
      )}

      {(gen.running || gen.text || gen.error) && !notReady && (
        <div className="space-y-1.5">
          <pre className="max-h-40 overflow-auto bg-inset border border-fg/10 rounded p-2 text-xs mono whitespace-pre-wrap break-words text-fg/80">
            {proposal ?? gen.text}{gen.running && <span className="animate-pulse">▋</span>}
          </pre>
          {gen.error && <div className="text-[11px] text-danger">⚠ {gen.error}</div>}
          {verdict && verdict.level !== "safe" && (
            <div className={`flex items-center gap-1 text-[11px] ${verdict.level === "block" ? "text-danger" : "text-warning"}`}>
              <Icon icon={verdict.level === "block" ? ShieldAlert : AlertTriangle} size={12} />
              {verdict.level === "block" ? t("已封鎖：{reasons}", { reasons: verdict.reasons.join("、") }) : t("送出前會先確認：{reasons}", { reasons: verdict.reasons.join("、") })}
            </div>
          )}
          {proposal && !gen.running && (
            <div className="flex gap-2">
              <Button variant="primary" disabled={verdict?.level === "block"} onClick={() => onApply(proposal)}>{t("放進指令列")}</Button>
              <Button variant="secondary" icon={ClipboardCopy} onClick={() => void copyToClipboard(proposal)}>{t("複製")}</Button>
              <Button variant="ghost" icon={RotateCw} onClick={generate}>{t("重新生成")}</Button>
            </div>
          )}
          {!proposal && !gen.running && gen.text && (
            <div className="text-[11px] text-fg/50">{t("未取得指令，請重試或改寫描述")}</div>
          )}
        </div>
      )}
    </div>
  );
}
