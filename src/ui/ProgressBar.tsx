// 2px 高的不確定進度條：資料表重載 / 面板長時載入的視覺回饋。
// 舊內容保持可見（不閃白），只在頂部滑動細條表示「正在載入」。
export default function ProgressBar({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="progress-track" role="progressbar" aria-label="載入中">
      <div className="progress-thumb" />
    </div>
  );
}
