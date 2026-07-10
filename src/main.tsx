import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyDocLang, readStoredLang, t, useLang } from "./i18n";
// 自我托管字體（離線內嵌，不連 CDN）：Inter 作介面字、JetBrains Mono 作資料 / SQL 等寬字。
// 只內嵌 latin / latin-ext 子集（fonts.css），取代裸 import 的全語系 14 檔。
import "./fonts.css";
import "./styles.css";

// 全域錯誤邊界：任一渲染錯誤時顯示友善訊息與重載鈕，避免整頁白屏。
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-elevated border border-fg/10 rounded-lg p-6 space-y-3">
            <div className="text-red-300 font-medium">{t("發生未預期的錯誤")}</div>
            <pre className="text-xs text-fg/60 mono whitespace-pre-wrap break-all max-h-60 overflow-auto bg-inset rounded p-3">
              {this.state.error.message}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5"
              >
                {t("嘗試繼續")}
              </button>
              <button
                type="button"
                onClick={() => location.reload()}
                className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90"
              >
                {t("重新載入")}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

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
