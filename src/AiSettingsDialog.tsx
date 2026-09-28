import { useEffect, useState } from "react";
import { Bot, Check, Library, Trash2 } from "lucide-react";
import { api, type AgentProvider } from "./api";
import { useT } from "./i18n";
import { Button, Field, Icon, Input, Modal, Select } from "./ui/index";
import lazyOverlay from "./ui/lazyOverlay";
import { baseUrlOf, DEFAULT_BASE_URL, isApiProvider, presetsFor, PROVIDERS, useAiProvider } from "./aiProvider";
import { assistantPersonaName, assistantPersonas, useAiSkills } from "./aiSkills";
import { entryTitle, updateLibrarySettings, useAiLibrary } from "./aiLibrary";

const AiLibraryDialog = lazyOverlay(() => import("./AiLibraryDialog"));

// AI 設定：API 供應商的連線（Base URL / 金鑰 / 模型）＋ 助手人設與技能的選擇（內容在 AI 資源庫）。
//
// 金鑰只寫進 OS keychain，前端拿不到明文 —— 所以輸入框永遠是空的，
// 旁邊用「已設定 / 未設定」表示狀態，要換就直接覆寫、要刪就按清除。
export default function AiSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const provider = useAiProvider((s) => s.provider);
  const setProvider = useAiProvider((s) => s.setProvider);
  const baseUrls = useAiProvider((s) => s.baseUrls);
  const setBaseUrl = useAiProvider((s) => s.setBaseUrl);
  const models = useAiProvider((s) => s.models);
  const setModel = useAiProvider((s) => s.setModel);

  const selected = useAiSkills((s) => s.selected);
  const toggle = useAiSkills((s) => s.toggle);
  // 訂閱快照：資源庫改了（新增技能 / 換人設）清單要跟著更新。
  const snapshot = useAiLibrary((s) => s.snapshot);
  const [libOpen, setLibOpen] = useState(false);

  // 設定畫面獨立於「目前使用中的供應商」：可以先設定好 API，之後再切過去。
  const [target, setTarget] = useState<AgentProvider>(isApiProvider(provider) ? provider : "openai-api");
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [modelList, setModelList] = useState<string[]>([]);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  const base = baseUrlOf(target, baseUrls);
  const model = models[target] ?? "";

  useEffect(() => {
    if (!open) return;
    setKey("");
    setTestMsg(null);
    setModelList([]);
    api.llmKeyStatus(target).then(setHasKey).catch(() => setHasKey(false));
  }, [open, target]);

  const saveKey = async (value: string) => {
    await api.llmKeySet(target, value);
    setKey("");
    setHasKey(await api.llmKeyStatus(target).catch(() => false));
  };

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const list = await api.llmListModels(target, base);
      setModelList(list);
      setTestMsg(list.length ? t("連線成功，取得 {n} 個模型", { n: list.length }) : t("連得上，但這個端點沒有回模型清單（模型請自己填）"));
    } catch (e: any) {
      setTestMsg(`⚠ ${e?.message ?? t("測試失敗")}`);
    } finally {
      setTesting(false);
    }
  };

  // snapshot 是刻意的依賴：assistantPersonas / all() 讀的是 store 的即時快照。
  void snapshot;
  const skills = useAiSkills.getState().all();
  const assistantList = assistantPersonas();
  const assistantName = assistantPersonaName();

  return (
    <Modal open={open} onClose={onClose} title={t("AI 設定")} icon={Bot} size="lg">
      <div className="space-y-5">
        <section className="space-y-3">
          <div className="text-xs font-medium text-fg/70">{t("使用中的供應商")}</div>
          <Field hint={t("claude / codex 用你自己的訂閱登入；API 供應商需要 Base URL 與金鑰（地端端點可免金鑰）。")}>
            <Select value={provider} onChange={(e) => setProvider(e.target.value as AgentProvider)}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        </section>

        <section className="space-y-3 border-t border-fg/10 pt-4">
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-fg/70">{t("API 供應商設定")}</div>
            <Select
              selectSize="sm"
              className="w-40"
              value={target}
              onChange={(e) => setTarget(e.target.value as AgentProvider)}
            >
              {PROVIDERS.filter((p) => p.kind === "api").map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>

          <Field label={t("預設服務")} hint={t("挑一個就會帶入它的 Base URL；也可以自己填。")}>
            <Select
              value=""
              onChange={(e) => {
                const p = presetsFor(target).find((x) => x.id === e.target.value);
                if (p) setBaseUrl(target, p.baseUrl);
              }}
            >
              <option value="">{t("（選擇以帶入）")}</option>
              {presetsFor(target).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.local ? t("（地端）") : ""} · {p.baseUrl}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t("Base URL")} hint={t("結尾有沒有 /v1 都可以，自帶路徑（如 /anthropic）會照原樣使用。")}>
            <Input
              value={baseUrls[target] ?? ""}
              placeholder={DEFAULT_BASE_URL[target] ?? ""}
              onChange={(e) => setBaseUrl(target, e.target.value)}
            />
          </Field>

          <Field
            label={t("API Key")}
            hint={hasKey ? t("已設定（存在系統金鑰庫，不會顯示明文）") : t("未設定。地端端點（Ollama / LM Studio）可以留空。")}
          >
            <div className="flex gap-2">
              <Input
                type="password"
                value={key}
                placeholder={hasKey ? "••••••••" : t("貼上金鑰")}
                onChange={(e) => setKey(e.target.value)}
                className="flex-1"
              />
              <Button variant="secondary" disabled={!key.trim()} onClick={() => void saveKey(key)}>
                {t("儲存")}
              </Button>
              {hasKey && (
                <Button variant="ghost" icon={Trash2} onClick={() => void saveKey("")}>
                  {t("清除")}
                </Button>
              )}
            </div>
          </Field>

          <Field label={t("模型")} hint={t("按「測試連線」可從端點抓清單；抓不到就直接填模型名稱。")}>
            <div className="flex gap-2">
              {modelList.length > 0 ? (
                <Select className="flex-1" value={model} onChange={(e) => setModel(target, e.target.value)}>
                  <option value="">{t("（未指定）")}</option>
                  {modelList.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input className="flex-1" value={model} placeholder="gpt-5 / claude-sonnet-5 / qwen3…" onChange={(e) => setModel(target, e.target.value)} />
              )}
              <Button variant="secondary" onClick={() => void test()} disabled={testing || !base}>
                {testing ? t("測試中…") : t("測試連線")}
              </Button>
            </div>
          </Field>
          {testMsg && <div className="text-[11px] text-fg/60">{testMsg}</div>}
          <div className="text-[11px] text-fg/40 leading-relaxed">
            {t("API 供應商的工具只有助手工作資料夾內的檔案讀寫與搜尋，沒有網路搜尋。")}
          </div>
        </section>

        <section className="space-y-3 border-t border-fg/10 pt-4">
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-fg/70">{t("人設與技能")}</div>
            <Button className="ml-auto" variant="ghost" icon={Library} onClick={() => setLibOpen(true)}>
              {t("開啟 AI 資源庫…")}
            </Button>
          </div>
          <div className="text-[11px] text-fg/45 leading-relaxed">
            {t("人設、技能與所有提示範本都是 AI 資源庫裡的 Markdown 檔（格式相容 Claude Code / Codex）：可以在資源庫編輯、覆蓋內建版本，或加入團隊共用的資料夾。")}
          </div>
          <Field label={t("助手人設")} hint={t("對話、NL→SQL 與編輯器 AI 動作共用；四種供應商都吃同一份。")}>
            <Select value={assistantName} onChange={(e) => void updateLibrarySettings({ assistant_persona: e.target.value }).catch(() => {})}>
              {assistantList.map((e) => (
                <option key={e.name} value={e.name}>
                  {entryTitle(e)} · {e.layerLabel}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("助手對話勾選的技能")} hint={t("勾起來的會附在人設後面，可複選；一次性生成（NL→SQL、改寫）不帶技能。")}>
            <div className="flex flex-wrap gap-1.5">
              {skills.map((s) => {
                const on = selected.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggle(s.id)}
                    title={on ? t("停用") : t("啟用")}
                    className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${
                      on ? "border-accent bg-accent/15 text-fg" : "border-fg/15 text-fg/60 hover:border-fg/30"
                    }`}
                  >
                    {on && <Icon icon={Check} size={11} />}
                    {s.name}
                  </button>
                );
              })}
            </div>
          </Field>
        </section>
      </div>
      {libOpen && <AiLibraryDialog open onClose={() => setLibOpen(false)} />}
    </Modal>
  );
}
