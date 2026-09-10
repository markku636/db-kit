import { useEffect, useState } from "react";
import { Bot, Check, Plus, RotateCcw, Trash2, Wand2 } from "lucide-react";
import { api, type AgentProvider } from "./api";
import { useT } from "./i18n";
import { Button, Field, Icon, Input, Modal, Select, Textarea } from "./ui/index";
import { baseUrlOf, DEFAULT_BASE_URL, isApiProvider, presetsFor, PROVIDERS, useAiProvider } from "./aiProvider";
import { BUILTIN_SKILLS, defaultPersona, useAiSkills } from "./aiSkills";

// AI 設定：API 供應商的連線（Base URL / 金鑰 / 模型）＋ 人設 ＋ 技能範本。
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

  const persona = useAiSkills((s) => s.persona);
  const setPersona = useAiSkills((s) => s.setPersona);
  const custom = useAiSkills((s) => s.custom);
  const selected = useAiSkills((s) => s.selected);
  const toggle = useAiSkills((s) => s.toggle);
  const addSkill = useAiSkills((s) => s.add);
  const updateSkill = useAiSkills((s) => s.update);
  const removeSkill = useAiSkills((s) => s.remove);

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

  const skills = [...BUILTIN_SKILLS, ...custom];

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
          <div className="text-xs font-medium text-fg/70">{t("人設")}</div>
          <Field hint={t("四種供應商共用。留白就用內建的預設人設。")}>
            <Textarea
              rows={4}
              value={persona}
              placeholder={defaultPersona()}
              onChange={(e) => setPersona(e.target.value)}
            />
          </Field>
          {persona.trim() !== "" && (
            <Button variant="ghost" icon={RotateCcw} onClick={() => setPersona("")}>
              {t("還原預設人設")}
            </Button>
          )}
        </section>

        <section className="space-y-3 border-t border-fg/10 pt-4">
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-fg/70">{t("技能")}</div>
            <span className="text-[11px] text-fg/40">{t("勾起來的會附在人設後面，可複選")}</span>
            <Button
              className="ml-auto"
              variant="ghost"
              icon={Plus}
              onClick={() => addSkill(t("新技能"), "")}
            >
              {t("新增")}
            </Button>
          </div>

          <div className="space-y-2">
            {skills.map((s) => {
              const on = selected.includes(s.id);
              const name = s.builtin ? t(s.name) : s.name;
              const body = s.builtin ? t(s.body) : s.body;
              return (
                <div key={s.id} className="rounded border border-fg/10 bg-inset/40 p-2 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggle(s.id)}
                      title={on ? t("停用") : t("啟用")}
                      className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 ${
                        on ? "bg-accent border-accent text-white" : "border-fg/25 text-transparent"
                      }`}
                    >
                      <Icon icon={Check} size={11} />
                    </button>
                    {s.builtin ? (
                      <span className="text-xs text-fg/80">{name}</span>
                    ) : (
                      <Input
                        inputSize="sm"
                        className="flex-1"
                        value={s.name}
                        onChange={(e) => updateSkill(s.id, { name: e.target.value })}
                      />
                    )}
                    {s.builtin ? (
                      <Button
                        className="ml-auto"
                        variant="ghost"
                        icon={Wand2}
                        onClick={() => addSkill(`${name}（${t("自訂")}）`, body)}
                      >
                        {t("複製為自訂")}
                      </Button>
                    ) : (
                      <Button className="ml-auto" variant="ghost" icon={Trash2} onClick={() => removeSkill(s.id)}>
                        {t("刪除")}
                      </Button>
                    )}
                  </div>
                  {s.builtin ? (
                    <div className="text-[11px] text-fg/50 leading-relaxed pl-6">{body}</div>
                  ) : (
                    <Textarea rows={3} value={s.body} onChange={(e) => updateSkill(s.id, { body: e.target.value })} />
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </Modal>
  );
}
