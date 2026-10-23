import { useEffect, useState } from "react";
import type { BillingSummary } from "./api";

export function money(micros: number): string {
  return `¥${(micros / 1_000_000).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}
export function CostDetails({summary}:{summary:BillingSummary}) {
  const total=summary.spentMicros+summary.reservedMicros;
  return <div className="cost-summary" aria-label="任务费用估算">
    {summary.unknown && total===0 ? <p>费用未知</p> : <p>{summary.unknown?"已知部分估算":"累计估算"} <strong>{money(total)}</strong></p>}
    {summary.reservedMicros>0 && <p className="muted">含请求中或未报告用量的估算 {money(summary.reservedMicros)}</p>}
    {summary.unknown && <p className="muted">部分请求缺少价格或用量，无法计算完整费用；用量记录仍保留。</p>}
    <small className="muted">按配置单价估算，非服务商最终账单。</small>
  </div>;
}
export function CostSummary({ ownerId }: { ownerId: string }) {
  const [summary, setSummary] = useState<BillingSummary>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setSummary(undefined);
    const update = () => void window.novel.billingSummary(ownerId).then(value => {
      if (active) { setSummary(value); setFailed(false); }
    }).catch(() => { if (active) setFailed(true); });
    update();
    const timer = setInterval(update, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [ownerId]);
  if (!summary) return failed ? <p className="muted">费用暂时无法读取，请稍后重试。</p> : null;
  return <CostDetails summary={summary} />;
}
