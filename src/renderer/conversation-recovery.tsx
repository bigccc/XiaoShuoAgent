import { useEffect, useState } from "react";
import type { ConversationTurn } from "../shared/types";

export function ConversationRecovery({ turn }: { turn: ConversationTurn }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ConversationTurn>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    setDetail(undefined);
    setError("");
    void window.novel.conversation(turn.id).then(
      result => { if (active) setDetail(result); },
      () => { if (active) setError("读取回复记录失败，请收起后重试"); },
    );
    return () => { active = false; };
  }, [open, turn.id, turn.revision]);
  if (turn.status === "running") return null;
  if (!turn.attempts?.length && !["failed", "cancelled", "interrupted"].includes(turn.status)) return null;
  return <details className="chat-details conversation-recovery" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>查看本轮回复与恢复记录</summary>
    {open && !detail && <p>{error || "正在读取记录…"}</p>}
    {detail && <>
      <p>原始回复仅供查看。未通过校验的内容不会作为正文保存。</p>
      {detail.attempts?.map((attempt, index) => <section key={index}>
        <strong>第 {index + 1} 次 · {attempt.phase === "repair" ? "整理回复格式" : "获取创作回复"}</strong>
        <p>{attempt.error || (attempt.status === "completed" ? "回复已通过格式校验" : "请求未完成")}</p>
        <p>{attempt.usage?.totalTokens == null ? "模型未报告用量" : `${attempt.usage.totalTokens.toLocaleString()} Token`}</p>
        {attempt.diagnostics && <details>
          <summary>响应信息</summary>
          <p>正文 {attempt.diagnostics.receivedChars.toLocaleString()} 字符 · 思考内容 {attempt.diagnostics.reasoningChars.toLocaleString()} 字符（只记录长度） · 结束原因 {attempt.diagnostics.finishReason ?? "未报告"} · {attempt.diagnostics.streamCompleted ? "响应已结束" : "未收到完整结束标记"}</p>
        </details>}
        {attempt.rawResponse && <details>
          <summary>查看原始回复</summary>
          <pre>{attempt.rawResponse}</pre>
        </details>}
      </section>)}
      {!detail.attempts?.length && <pre>{detail.rawResponse || "这条历史记录没有保存原始回复。"}</pre>}
    </>}
  </details>;
}
