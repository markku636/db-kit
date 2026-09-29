import type { ReactNode } from "react";
import { CircleHelp, ShieldCheck, Sparkles, Table2, type LucideIcon } from "lucide-react";
import { useT } from "./i18n";
import { Badge, Button, Icon, Modal } from "./ui/index";

// 「DBA 審查怎麼用」說明窗：AI 資源庫裡只看得到範本（review-*），看不出它們是從哪個按鈕觸發的。
// 三個入口各對應一個範本；從範本標頭點開時，對應的那張卡片會標成「目前這個範本」。

export const DBA_REVIEW_TEMPLATES = ["review-sql", "review-pre-exec", "review-schema"] as const;
export type DbaReviewTemplate = (typeof DBA_REVIEW_TEMPLATES)[number];

export function isDbaReviewTemplate(name: string): name is DbaReviewTemplate {
  return (DBA_REVIEW_TEMPLATES as readonly string[]).includes(name);
}

/** UI 上的按鈕 / 選單名稱，照畫面上的樣子框起來，讓人對得上。 */
function Ui({ children }: { children: ReactNode }) {
  return <span className="inline-block px-1 mx-0.5 rounded border border-fg/15 bg-fg/5 text-fg/85 text-[11px] leading-[1.35rem]">{children}</span>;
}

function Entry({
  icon,
  title,
  template,
  focused,
  steps,
  sends,
  onOpenTemplate,
}: {
  icon: LucideIcon;
  title: string;
  template: DbaReviewTemplate;
  focused: boolean;
  steps: ReactNode[];
  sends: string;
  onOpenTemplate?: (name: DbaReviewTemplate) => void;
}) {
  const t = useT();
  return (
    <div className={`rounded-md border p-3 space-y-2 ${focused ? "border-accent/60 bg-accent/5" : "border-fg/10 bg-elevated"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <Icon icon={icon} size={14} className="text-accent" />
        <span className="text-[13px] font-medium text-fg/90">{title}</span>
        {focused && <Badge tone="accent">{t("目前這個範本")}</Badge>}
        {onOpenTemplate ? (
          <button
            type="button"
            onClick={() => onOpenTemplate(template)}
            title={t("在資源庫開啟這個範本")}
            className="ml-auto font-mono text-[11px] text-fg/50 hover:text-accent hover:underline"
          >
            {template}
          </button>
        ) : (
          <span className="ml-auto font-mono text-[11px] text-fg/45">{template}</span>
        )}
      </div>
      <ol className="list-decimal pl-5 space-y-0.5 text-[12px] text-fg/75 leading-relaxed">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <div className="text-[11px] text-fg/50 leading-relaxed">
        <span className="text-fg/40">{t("送給 DBA 的內容：")}</span>
        {sends}
      </div>
    </div>
  );
}

export default function DbaReviewHelp({
  onClose,
  focus,
  onOpenTemplate,
}: {
  onClose: () => void;
  /** 從哪個範本點開（標出對應的入口）。 */
  focus?: string | null;
  /** 給了就讓範本名稱可點：關掉說明窗並在資源庫選到那個範本。 */
  onOpenTemplate?: (name: DbaReviewTemplate) => void;
}) {
  const t = useT();
  const open = onOpenTemplate
    ? (name: DbaReviewTemplate) => {
        onClose();
        onOpenTemplate(name);
      }
    : undefined;
  const h = "text-xs font-medium text-fg/70";
  return (
    <Modal
      onClose={onClose}
      title={t("DBA 審查怎麼用")}
      icon={CircleHelp}
      size="lg"
      zClass="z-[110]"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("知道了")}
        </Button>
      }
    >
      <div className="space-y-5">
        <p className="text-[12px] text-fg/70 leading-relaxed">
          {t("把 SQL 或資料表結構交給一位（或多位）DBA 人設看過再動手。連線著的時候，DBA 不只讀你給的內容，還會自己用唯讀工具查執行計畫、欄位、索引與列數，確認後才下結論——它查了什麼都會列在結果裡。")}
        </p>

        <section className="space-y-2">
          <div className={h}>{t("從哪裡開始（三個入口）")}</div>
          <Entry
            icon={Sparkles}
            title={t("審查編輯器裡的 SQL")}
            template="review-sql"
            focused={focus === "review-sql"}
            steps={[
              t("在查詢分頁寫好 SQL；只想審其中一段就先反白選取。"),
              <>
                {t("按工具列的")}
                <Ui>{t("更多")}</Ui>→<Ui>{t("DBA 審查")}</Ui>
              </>,
              <>
                {t("下方會切到")}
                <Ui>{t("審查")}</Ui>
                {t("分頁並自動送出；之後換人設再按")}
                <Ui>{t("重新審查")}</Ui>
                {t("即可。")}
              </>,
            ]}
            sends={t("選取的 SQL（沒選取就是整段）、規則引擎找到的問題、相關表的結構與索引、已經跑過的執行計畫。")}
            onOpenTemplate={open}
          />
          <Entry
            icon={ShieldCheck}
            title={t("執行寫入腳本之前（審查並執行）")}
            template="review-pre-exec"
            focused={focus === "review-pre-exec"}
            steps={[
              <>
                {t("按查詢分頁工具列「執行」左邊的盾牌鈕")}
                <Ui>{t("審查並執行")}</Ui>
                {t("（有反白選取時只處理選取段）。")}
              </>,
              t("對話框一打開，右側就會自動送審；不想自動送可在「選項」取消「開啟時自動審查」。"),
              t("看完結論再決定「只產生備份」或「執行（含備份）」。AI 沒設定或失敗也能繼續，備份與回滾不受影響。"),
            ]}
            sends={t("要執行的腳本、逐句分析、目標表結構與估算列數。預設不送任何實際資料（「附前像樣本給 AI」預設為 0）。")}
            onOpenTemplate={open}
          />
          <Entry
            icon={Table2}
            title={t("審查一張資料表的結構")}
            template="review-schema"
            focused={focus === "review-schema"}
            steps={[
              <>
                {t("在側欄的資料表上按右鍵 →")}
                <Ui>{t("問 AI")}</Ui>→<Ui>{t("DBA 審查結構…")}</Ui>
              </>,
              t("開啟後自動送出，預設由「資料模型架構師」審查。"),
            ]}
            sends={t("建表 DDL、欄位、索引、外鍵、列數與大小。")}
            onOpenTemplate={open}
          />
          <p className="text-[11px] text-fg/45 leading-relaxed">
            {t("命令列也有：`dbk run 腳本.sql --out 目錄 --review-cmd \"claude -p\"`，用的是和「審查並執行」同一份範本。")}
          </p>
        </section>

        <section className="space-y-2">
          <div className={h}>{t("結論怎麼看")}</div>
          <p className="text-[12px] text-fg/65">{t("回覆的第一行一定是結論：")}</p>
          <div className="grid grid-cols-[auto,1fr] items-center gap-x-3 gap-y-1.5 text-[12px] text-fg/75">
            <Badge tone="success">GO</Badge>
            <span>{t("照寫的樣子執行是安全的")}</span>
            <Badge tone="warning">CAUTION</Badge>
            <span>{t("可以執行，但請先看過風險")}</span>
            <Badge tone="danger">STOP</Badge>
            <span>{t("不應照原樣執行")}</span>
          </div>
        </section>

        <section className="space-y-2">
          <div className={h}>{t("審查面板上可以做什麼")}</div>
          <ul className="list-disc pl-5 space-y-1 text-[12px] text-fg/75 leading-relaxed">
            <li>{t("點人設 chip 換人；選多位就是會審，各自一個分頁，「綜合」結論取最嚴格的那位。")}</li>
            <li>{t("「會審」按鈕：一鍵套用設定好的會審陣容。")}</li>
            <li>{t("「工具呼叫」清單：DBA 實際下了哪些查詢、拿回幾列、花多久。")}</li>
            <li>{t("回覆裡的 SQL 可以「套用到編輯器」，先看差異再逐塊接受。")}</li>
            <li>{t("「在助手中追問」：把審查結果帶到右側助手繼續問。")}</li>
            <li>{t("「編輯本次提示」：送出前先看、改這一次要送的內容（只用這一次，不改資源庫）。")}</li>
          </ul>
        </section>

        <section className="space-y-2">
          <div className={h}>{t("預設是誰來審、怎麼改")}</div>
          <ul className="list-disc pl-5 space-y-1 text-[12px] text-fg/75 leading-relaxed">
            <li>{t("一般連線預設「資深 DBA」，標記為正式環境的連線預設「正式環境守門員」。")}</li>
            <li>{t("換預設人設、設定會審陣容：資源庫的「來源與同步」分頁。")}</li>
            <li>{t("改 DBA 的審查標準（什麼情況算 STOP）：「人設」分頁；要它每次都帶某種專業知識，就在人設裡「預載」那個技能。")}</li>
            <li>{t("改每個入口送出的指令：「提示範本」分頁的 review-sql / review-pre-exec / review-schema。")}</li>
          </ul>
        </section>
      </div>
    </Modal>
  );
}
