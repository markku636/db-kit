// PayPal 贊助連結。四個固定金額走 PayPal 的 hosted payment 頁（收款人與金額都已經
// 綁在連結裡，使用者點進去只要按付款），其餘金額走 PayPal.Me 讓人自己填。
//
// 為什麼固定金額要各給一條連結、而不是一條 PayPal.Me 加一句「隨意」：
// 「隨意」是贊助頁最貴的一個字 —— 它把「要不要贊助」變成「該給多少才不失禮」，
// 而後者要想，想了就關掉了。四個金額是四個不用想的選項。
//
// 這份清單與 README 的贊助段、`.github/FUNDING.yml` 是同一組連結；
// 換收款帳號時三處都要改（同一組連結也用在 ai-music-cut / open-pos /
// Super Mermaid / Refactory，那幾個 repo 各有一份自己的副本）。

export const PAYPAL_ME_URL = "https://paypal.me/226network";

export interface DonateTier {
  /** 美元金額。顯示用 `$5` 這種寫法，不進翻譯表（數字與貨幣符號各語言一致）。 */
  readonly usd: number;
  readonly url: string;
}

export const DONATE_TIERS: readonly DonateTier[] = [
  { usd: 5, url: "https://www.paypal.com/ncp/payment/8B7GRXA6UJH36" },
  { usd: 10, url: "https://www.paypal.com/ncp/payment/8LBTFUBBF2CHS" },
  { usd: 15, url: "https://www.paypal.com/ncp/payment/A653DD46GEU4W" },
  { usd: 25, url: "https://www.paypal.com/ncp/payment/Y5WPSXVGH3YS4" },
];
