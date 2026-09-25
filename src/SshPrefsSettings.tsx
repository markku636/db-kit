// 設定對話框的「SSH 終端機」小節：剪貼簿習慣、渲染器、scrollback。全部是前端偏好（localStorage，見 sshPrefs.ts），
// 改了立刻套到所有開著的終端機（SshTerminalPane 訂閱同一個 store）。
import { SquareTerminal } from "lucide-react";
import { useT } from "./i18n";
import { Field, Icon, Select } from "./ui/index";
import { SCROLLBACK_MAX, SCROLLBACK_MIN, useSshPrefs } from "./sshPrefs";

export default function SshPrefsSettings() {
  const t = useT();
  const prefs = useSshPrefs();
  const set = useSshPrefs((s) => s.set);
  const Check = ({ k, label, hint }: { k: "copyOnSelect" | "rightClickPaste" | "warnMultilinePaste" | "cursorBlink"; label: string; hint?: string }) => (
    <label className="flex items-start gap-2 text-sm text-fg/80 cursor-pointer select-none">
      <input type="checkbox" className="mt-1" checked={prefs[k]} onChange={(e) => set({ [k]: e.target.checked })} />
      <span>
        {label}
        {hint && <span className="block text-xs text-fg/45 leading-relaxed">{hint}</span>}
      </span>
    </label>
  );
  return (
    <div className="pt-4 border-t border-fg/10 space-y-3">
      <div className="text-sm font-medium text-fg/80 flex items-center gap-1.5">
        <Icon icon={SquareTerminal} size={15} /> {t("SSH 終端機")}
      </div>
      <div className="space-y-2">
        <Check k="copyOnSelect" label={t("選取文字時自動複製")} hint={t("Xshell / PuTTY 習慣：滑鼠一放開就進剪貼簿。")} />
        <Check k="rightClickPaste" label={t("右鍵貼上")} hint={t("無選取時右鍵直接貼上；有選取時右鍵＝複製。關掉則右鍵開選單。")} />
        <Check k="warnMultilinePaste" label={t("多行貼上前先確認")} hint={t("貼進終端機的每一行都會被當成 Enter 執行，先看一眼再送。")} />
        <Check k="cursorBlink" label={t("游標閃爍")} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("渲染器")} hint={t("遠端桌面 / 虛擬機沒有 GPU 時改用 DOM；新開的終端機才生效。")}>
          <Select selectSize="md" value={prefs.renderer} onChange={(e) => set({ renderer: e.target.value as "auto" | "dom" })}>
            <option value="auto">{t("自動（優先 WebGL）")}</option>
            <option value="dom">DOM</option>
          </Select>
        </Field>
        <Field label={t("回捲行數")} hint={t("每個分頁保留的歷史輸出行數（{min}–{max}）。", { min: SCROLLBACK_MIN, max: SCROLLBACK_MAX })}>
          <Select selectSize="md" value={String(prefs.scrollback)} onChange={(e) => set({ scrollback: Number(e.target.value) })}>
            {[1000, 5000, 10000, 20000, 50000].map((n) => (
              <option key={n} value={String(n)}>{n.toLocaleString()}</option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  );
}
