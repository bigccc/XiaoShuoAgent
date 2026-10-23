import { useCallback, useEffect, useRef, useState } from "react";
import type { Command } from "../shared/types";
import type { BillingQuote, BillingSummary } from "./api";
import { Modal } from "./modal";

export function money(micros: number): string {
  return `¥${(micros / 1_000_000).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}
export function budgetInput(micros: number): string {
  return (Math.ceil(micros / 10_000) / 100).toFixed(2);
}
export function parseBudget(value: string): number | undefined {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return undefined;
  const micros = Math.round(Number(value) * 1_000_000);
  return Number.isSafeInteger(micros) && micros >= 0 ? micros : undefined;
}
export class CostCancelled extends Error {
  constructor() { super("已取消，本次未发送 AI 请求。"); }
}

function operationScope(command: Command): string {
  const names: Record<string, string> = { "conversation.send": "创作对话及由本次要求发起的写作", "conversation.retry": "重试本轮创作", "writing.start": "连续写作", "writing.resume": "继续尚未完成的写作步骤", "ai.check": "主动检查正文", "ai.plan": "生成规划建议", "ai.chapter": "生成本章正文", "ai.extract": "提取素材", "model.test": "测试 AI 连接", "revision.start": "生成待审稿", "revision.resume": "继续改稿", "scene.plan": "规划本章场景", "scene.resume": "继续场景规划", "scene.revise": "生成场景待审稿", "voice.extract": "提取文风", "voice.resume": "继续文风提取", "story.job.start": "提取章节状态", "story.job.resume": "继续提取章节状态", "structure.revise": "生成所选结构待审稿", "authoring.sync": "同步故事资料", "authoring.retrySync": "重试资料同步", "task.resume": "继续任务" };
  const label = names[command.type] ?? "本次 AI 操作";
  if ("goal" in command) return `${label} · 第 ${command.goal.startOrdinal}–${command.goal.endOrdinal} 章`;
  if ("chapterIds" in command && command.chapterIds) return `${label} · 所选 ${command.chapterIds.length} 章`;
  if (command.type === "ai.check") return `${label} · 当前作品已有章节`;
  return label;
}
type Approval = { id: number; scope: string; quote: BillingQuote; resolve: (value: number | undefined) => void };
export function useCostApproval() {
  const [requests, setRequests] = useState<Approval[]>([]);
  const sequence = useRef(0);
  const outstanding = useRef(new Set<Approval>());
  useEffect(() => () => {
    for (const request of outstanding.current) request.resolve(undefined);
    outstanding.current.clear();
  }, []);
  const approve = useCallback(async (command: Command) => {
    const quote = await window.novel.billingQuote(command);
    if (!quote.required) return undefined;
    const amount = await new Promise<number | undefined>(resolve => {
      const request = { id: ++sequence.current, scope: operationScope(command), quote, resolve };
      outstanding.current.add(request);
      setRequests(previous => [...previous, request]);
    });
    if (amount === undefined) throw new CostCancelled();
    return { budgetMicros: amount };
  }, []);
  const request = requests[0];
  const close = (value?: number) => {
    if (!request) return;
    outstanding.current.delete(request);
    request.resolve(value);
    setRequests(previous => previous.slice(1));
  };
  return { approve, dialog: request ? <CostApproval key={request.id} quote={request.quote} scope={request.scope} onClose={close} /> : null };
}
export function CostApproval({ quote, scope, onClose }: { quote: BillingQuote; scope?: string; onClose: (amount?: number) => void }) {
  const [value, setValue] = useState(() => budgetInput(quote.budgetMicros));
  const amount = parseBudget(value);
  const minimum = quote.minimumBudgetMicros ?? 0;
  const valid = amount !== undefined && amount >= minimum;
  return <Modal label="确认本次 AI 花费" onClose={() => onClose()}>
    <h2>本次 AI 花费</h2>
    {scope && <p>{scope}</p>}
    <p>预计花费：<strong>{money(quote.estimatedMicros)}</strong></p>
    {quote.priced ? <>
      <label>本次预算（元）<input autoFocus aria-label="本次预算（元）" inputMode="decimal" type="number" min={minimum / 1_000_000} step="0.01" value={value} onChange={event => setValue(event.target.value)} /></label>
      <p className="muted">包含生成、检查、自动修正和重试。费用按模型配置的价格估算；服务商最终账单可能不同。达到预算前会暂停，已有进度会保留。</p>
      {quote.budgetMicros > 0 && <p className="muted">建议总预算 {money(quote.budgetMicros)}，已有任务的累计花费会继续计入。</p>}
      {!valid && <p role="alert">请输入不低于 {money(minimum)} 的有效金额，最多两位小数。</p>}
    </> : <p className="error" role="alert">请先在 AI 连接中填写模型的输入与输出价格：{quote.missingProfiles.join("、")}。免费模型请明确填写 0。</p>}
    <div className="toolbar"><button onClick={() => onClose()}>取消</button><button className="primary" disabled={!quote.priced || !valid} onClick={() => valid && onClose(amount)}>按此预算开始</button></div>
  </Modal>;
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
  return <div className="cost-summary" aria-label="任务费用估算">
    {summary.unknown && summary.budgetMicros === 0 && summary.spentMicros === 0 && summary.reservedMicros === 0 ? <p>历史费用未知</p> : <p>累计估算 <strong>{money(summary.spentMicros + summary.reservedMicros)}</strong> · 剩余预算 {money(Math.max(0, summary.budgetMicros - summary.spentMicros - summary.reservedMicros))}</p>}
    {summary.reservedMicros > 0 && <p className="muted">含请求预留或未知用量估算 {money(summary.reservedMicros)}</p>}
    {summary.unknown && <p className="muted">部分历史费用或请求用量未知，以上金额包含已记录请求的保守预留。</p>}
    {(summary.nextMicros ?? 0) > 0 && <p>下一步预计 {money(summary.nextMicros!)}</p>}
    <small className="muted">按配置单价估算，非服务商最终账单。</small>
  </div>;
}
