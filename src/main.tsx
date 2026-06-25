import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// 自我托管字體（離線內嵌，不連 CDN）：Inter 作介面字、JetBrains Mono 作資料 / SQL 等寬字。
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
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
            <div className="text-red-300 font-medium">發生未預期的錯誤</div>
            <pre className="text-xs text-fg/60 mono whitespace-pre-wrap break-all max-h-60 overflow-auto bg-inset rounded p-3">
              {this.state.error.message}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5"
              >
                嘗試繼續
              </button>
              <button
                type="button"
                onClick={() => location.reload()}
                className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90"
              >
                重新載入
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
