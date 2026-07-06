import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

// 把「條件掛載的對話框 / 面板」包成 lazy 元件：首包不含其程式碼，開啟時才抓對應 chunk，
// 並自帶 Suspense 邊界 — JSX 使用處完全不變。本地 chunk 載入極快（<50ms），
// 預設 fallback=null（對話框閃 spinner 反而突兀）；面板類可傳同尺寸佔位。
// 注意：不轉發 ref；需要 ref 的元件（如 SqlEditor）請直接用 React.lazy + 手動 Suspense。
export default function lazyOverlay<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  fallback: ReactNode = null,
) {
  const L = lazy(load) as unknown as ComponentType<P>;
  return function LazyOverlay(props: P) {
    return (
      <Suspense fallback={fallback}>
        <L {...props} />
      </Suspense>
    );
  };
}
