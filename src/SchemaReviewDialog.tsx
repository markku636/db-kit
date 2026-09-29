import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { isProdConn, type DbKind } from "./api";
import { buildSchemaReviewPrompt, reviewersFor } from "./dbaReview";
import DbaReviewPane from "./DbaReviewPane";
import { useLang, useT } from "./i18n";
import { useStore } from "./store";
import { Modal } from "./ui/index";

/**
 * 側欄資料表右鍵「DBA 審查結構」：把 DDL、欄位、索引、外鍵與表資訊交給 DBA 人設審查資料模型。
 * 預設人設是「資料模型架構師」（專看正規化、鍵、型別與命名），可在面板上換人或多位會審。
 */
export default function SchemaReviewDialog({ connId, db, table, kind, onClose }: {
  connId: string;
  db: string;
  table: string;
  kind: DbKind;
  onClose: () => void;
}) {
  const t = useT();
  const prod = useStore((s) => s.connections.some((c) => c.id === connId && isProdConn(c)));
  const connected = useStore((s) => s.connectedIds.has(connId));
  // 開啟即審查一次（key 固定在掛載當下）。
  const [autoKey] = useState(() => Date.now());

  const prepare = async (names: string[]) => ({
    prompt: await buildSchemaReviewPrompt({ connId, kind, db, table, uiLang: useLang.getState().lang }),
    reviewers: reviewersFor(names),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={t("DBA 審查結構：{table}", { table: db ? `${db}.${table}` : table })}
      icon={ShieldCheck}
      size="xl"
      className="h-[80vh]"
      bodyClassName="p-4 flex flex-col min-h-0 overflow-hidden"
      dismissOnBackdrop={false}
    >
      <DbaReviewPane
        prepare={prepare}
        connId={connected ? connId : null}
        database={db || null}
        kind={kind}
        prod={prod}
        autoStartKey={autoKey}
        verdictLabels={{ go: t("結構良好"), caution: t("建議修正"), stop: t("有嚴重問題") }}
        followUpLabel={t("我對這張表的 DBA 結構審查有後續問題。請先用三句話總結最重要的設計問題，再等我追問。")}
        emptyHint={<p>{t("審查這張表的鍵與約束、型別、索引、正規化與命名，並給出修改用的 DDL。")}</p>}
      />
    </Modal>
  );
}
