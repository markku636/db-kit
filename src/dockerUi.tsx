// Docker / Registry / Harbor 詳情頁共用的小元件：資訊區塊、鍵值列、可複製的 JSON 區塊、統計磚。
import { useState, type ReactNode } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { IconButton } from "./ui/index";
import { copyToClipboard } from "./ui";
import { isSensitiveEnvKey, splitEnv } from "./dockerModel";
import { useT } from "./i18n";

export function InfoSection({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-fg/45">{title}</h3>
        {right && <div className="ml-auto flex items-center gap-1">{right}</div>}
      </div>
      <div className="rounded border border-fg/10 bg-inset/60">{children}</div>
    </section>
  );
}

export function InfoRow({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-3 px-3 py-1.5 border-b border-fg/5 last:border-b-0 text-xs">
      <div className="w-32 shrink-0 text-fg/45">{label}</div>
      <div className={`min-w-0 flex-1 break-all text-fg/85 ${mono ? "mono" : ""}`}>{children}</div>
    </div>
  );
}

/** 簡單表格：hand-rolled table 的共用外觀（本 repo 沒有共用 data table）。 */
export function MiniTable({ head, rows, empty }: { head: ReactNode[]; rows: ReactNode[][]; empty?: ReactNode }) {
  const t = useT();
  if (rows.length === 0) return <div className="px-3 py-2 text-xs text-fg/35">{empty ?? t("（無）")}</div>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-fg/40 border-b border-fg/10">
          {head.map((h, i) => <th key={i} className="px-3 py-1.5 font-normal whitespace-nowrap">{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-fg/5 last:border-b-0 hover:bg-fg/[0.03] align-top">
            {r.map((c, j) => <td key={j} className="px-3 py-1.5 break-all">{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 環境變數表：機密鍵預設遮罩，可逐一 / 全部顯示。 */
export function EnvTable({ env }: { env: string[] }) {
  const t = useT();
  const [reveal, setReveal] = useState(false);
  const rows = env.map((e) => {
    const [k, v] = splitEnv(e);
    const masked = !reveal && isSensitiveEnvKey(k) && v !== "";
    return [<span className="mono text-fg/70">{k}</span>, <span className="mono">{masked ? "••••••" : v}</span>];
  });
  return (
    <InfoSection
      title={t("環境變數（{n}）", { n: env.length })}
      right={
        <IconButton
          icon={reveal ? EyeOff : Eye}
          label={reveal ? t("遮罩機密值") : t("顯示機密值")}
          onClick={() => setReveal((v) => !v)}
        />
      }
    >
      <MiniTable head={[t("名稱"), t("值")]} rows={rows} />
    </InfoSection>
  );
}

export function JsonBlock({ title, json }: { title: ReactNode; json: string }) {
  const t = useT();
  return (
    <InfoSection
      title={title}
      right={<IconButton icon={Copy} label={t("複製 JSON")} onClick={() => copyToClipboard(json, t("已複製"))} />}
    >
      <pre className="mono text-[11px] leading-relaxed p-3 overflow-auto max-h-[480px] whitespace-pre text-fg/75">{json}</pre>
    </InfoSection>
  );
}

export function StatTile({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "warn" | "ok" | "dim" }) {
  const cls = tone === "warn" ? "text-warning" : tone === "ok" ? "text-success" : tone === "dim" ? "text-fg/50" : "text-fg/90";
  return (
    <div className="bg-inset rounded px-3 py-2 border border-fg/5 min-w-0">
      <div className="text-fg/40 text-[10px] truncate">{label}</div>
      <div className={`text-lg mono truncate ${cls}`}>{value}</div>
      {sub != null && <div className="text-fg/35 text-[10px] truncate">{sub}</div>}
    </div>
  );
}

export function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return <div className="px-3 py-1.5 text-xs text-danger mono break-all border-b border-fg/10">{text}</div>;
}
