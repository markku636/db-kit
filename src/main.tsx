import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import { applyDocLang, readStoredLang, useLang } from "./i18n";
// 自我托管字體（離線內嵌，不連 CDN）：Inter 作介面字、JetBrains Mono 作資料 / SQL 等寬字。
// 只內嵌 latin / latin-ext 子集（fonts.css），取代裸 import 的全語系 14 檔。
import "./fonts.css";
import "./styles.css";

const render = () =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );

// 語言啟動：zh-TW 是原文，catalog 恆空 → 同步渲染，不多付一個 tick、也不會先閃一次中文。
// 其餘語言必須先把譯文表載進來（vite dynamic import chunk）才首次繪製，否則會看到中文閃一下。
// 載入失敗（chunk 壞掉 / 離線）就照 identity fallback 渲染中文，總比白屏好。
const startLang = readStoredLang();
applyDocLang(startLang);
if (startLang === "zh-TW") render();
else void useLang.getState().setLang(startLang).catch(() => {}).then(render);
