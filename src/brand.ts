// 產品品牌名的單一真相。
//
// 兩個理由不讓 "DB Kit" 散落在 JSX 裡：
// 1. i18n —— 品牌名永不翻譯，集中成常數後 codemod 不會誤包 t()，文案則以 t("關於 {app}", { app: APP_NAME }) 參數化。
// 2. db-kit-qland-overlay 打包 qland 私有版時要把品牌改成 "DB Kit with Qland"。
//    改前它得在 AboutDialog.tsx / App.tsx 用 4 個字面值錨點做字串取代（其中兩個含中文，i18n 後必失效）；
//    改後只需 patch 本檔這一行，且錨點不含中文，往後 i18n 文案怎麼動都打不到 overlay。
export const APP_NAME = "DB Kit";
