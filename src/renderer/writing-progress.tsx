import { useEffect, useState } from "react";
import type { AppState } from "../shared/types";
import { MAX_WRITING_TOKEN_BUDGET, type WritingJob } from "../shared/writing";
import type { Run } from "./api";
import type { Flush } from "./editing";
import { authorError, budgetStopped, continuationBudget } from "./author-experience";
import { ContextReferences } from "./context-references";

const statusNames: Record<WritingJob["status"], string> = {
  running: "正在推进", paused: "已暂停", interrupted: "等待手动续跑",
  cancelled: "已取消", failed: "执行失败", "awaiting-author": "仍有待处理事项", completed: "任务已完成",
};
const phaseNames: Record<WritingJob["phase"], string> = {
  planning: "准备逐章计划", writing: "生成正文", checking: "检查正文",
  revising: "修订正文", reviewing: "跨章复核", done: "本轮已结束",
};
const issueNames: Record<WritingJob["issues"][number]["category"], string> = {
  character: "人物", timeline: "时间线", plot: "情节", world: "世界设定", knowledge: "信息认知",
  foreshadowing: "伏笔", style: "文风", pacing: "节奏", length: "篇幅",
};

export function WritingProgress({ job, state, run, flush, otherBusy, openChapter }: {
  job: WritingJob;
  state: AppState;
  run: Run;
  flush: Flush;
  otherBusy: boolean;
  openChapter: (id: string) => void;
}) {
  const [budget, setBudget] = useState(job.tokenBudget);
  const [profileId, setProfileId] = useState(job.profileId ?? "");
  const [clarification, setClarification] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setBudget((value) => Math.max(value, job.tokenBudget)), [job.tokenBudget]);
  const saved = job.chapters.filter((c) => c.chapterId && (c.existing || c.status !== "pending"));
  const checked = job.chapters.filter((c) => {
    if (c.checkedRevision === undefined) return c.status === "checked";
    const current = state.chapters.find((chapter) => chapter.id === c.chapterId);
    return !!current && current.revision === c.checkedRevision;
  });
  const needsReview = job.chapters.filter((c) => c.status === "needs-review").length;
  const resumable = ["paused", "interrupted", "failed", "awaiting-author"].includes(job.status);
  const selectedProfile = state.profiles.some((p) => p.id === profileId) ? profileId : "";
  const validBudget = Number.isSafeInteger(budget) && budget >= job.tokenBudget && budget <= MAX_WRITING_TOKEN_BUDGET;
  const latestChapter = saved.at(-1)?.chapterId;
  async function act(type: "writing.pause" | "writing.resume" | "writing.cancel", increase = false) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      if (type === "writing.resume") {
        if (!validBudget) throw Error("续跑总预算不能低于已设预算，且必须为有效整数。");
        if (!(await flush())) return;
      }
      await run({ type, id: job.id, ...(type === "writing.resume" ? {
        tokenBudget: increase ? continuationBudget(job.tokenBudget, MAX_WRITING_TOKEN_BUDGET) : budget,
        ...(selectedProfile ? { profileId: selectedProfile } : {}),
        ...(clarification.trim() ? { text: clarification.trim() } : {}),
      } : {}) });
      if (type === "writing.resume") setClarification("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未完成，请重试。");
    } finally { setPending(false); }
  }
  return (
    <section className="writing-progress" aria-label="连续写作任务" aria-busy={pending}>
      <header>
        <div><small>连续写作</small><h3>第 {job.goal.startOrdinal}–{job.goal.endOrdinal} 章</h3></div>
        <strong className={`writing-status writing-status-${job.status}`}>{statusNames[job.status]}</strong>
      </header>
      <p className="writing-request">{job.text}</p>
      <p role="status">{phaseNames[job.phase]}{job.status === "running" && job.chapters[job.cursor] ? ` · 第 ${job.chapters[job.cursor].ordinal} 章` : ""}</p>
      <div className="writing-counts">
        <div><span>已保存 {saved.length} / {job.chapters.length} 章</span><progress aria-label="连续写作保存进度" value={saved.length} max={job.chapters.length || 1} /></div>
        <div><span>已检查 {checked.length} / {job.chapters.length} 章</span><progress aria-label="连续写作检查进度" value={checked.length} max={job.chapters.length || 1} /></div>
      </div>
      <p className="muted">已保存不代表检查全部通过。{needsReview > 0 ? `仍有 ${needsReview} 章待处理。` : checked.length < job.chapters.length ? "其余章节仍待检查。" : job.phase !== "done" ? "还需完成跨章复核。" : "请结合问题与待审稿判断结果。"}</p>
      <details className="writing-budget"><summary>技术详情</summary>
        <span>预算已占用 {job.budgetUsed.toLocaleString()} / {job.tokenBudget.toLocaleString()} Token</span>
        <small>{job.usage?.totalTokens == null ? "模型尚未报告用量" : `模型${job.usage.estimated ? "估算" : "已报告"}用量 ${job.usage.totalTokens.toLocaleString()} Token`} · {job.calls} 次请求</small>
        {(job.usage?.totalTokens == null && job.budgetUsed > 0 || job.budgetUsed > (job.usage?.totalTokens ?? 0)) && <small>占用额度包含调用预留或未报告用量，续跑不会清零。</small>}
      </details>
      {job.reply && <p>{authorError(job.reply)}</p>}
      <ContextReferences references={job.contextReferences} chapters={state.chapters} label="逐章参考的远章原文（最近一次）" />
      {(job.error || error) && <p className="error" role="alert">{authorError(error || job.error || "")}</p>}
      {job.warnings.map((warning, index) => <p className="hint warn" key={index}>{warning}</p>)}
      {job.issues.length > 0 && <details className="writing-issues" open={job.status === "awaiting-author"}>
        <summary>{job.issues.length} 项待处理问题</summary>
        {job.issues.map((issue, index) => <article key={index}>
          <strong>{issueNames[issue.category]} · {issue.impact === "blocking" ? "影响后文，需处理" : "局部问题，待审"}</strong>
          <p>{issue.reason}</p>
          {issue.evidence.map((evidence, evidenceIndex) => <blockquote key={evidenceIndex}>{evidence.quote}</blockquote>)}
        </article>)}
      </details>}
      {resumable && <div className="writing-resume">
        <details><summary>高级设置</summary><label>连续写作 Token 总预算<input aria-label="连续写作 Token 总预算" type="number" min={job.tokenBudget} max={MAX_WRITING_TOKEN_BUDGET} step={1000} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></label>
        <label>续跑模型<select aria-label="连续写作续跑模型" value={selectedProfile} onChange={(e) => setProfileId(e.target.value)}><option value="">沿用任务模型</option>{state.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label></details>
        {job.status === "awaiting-author" && <label>补充说明<textarea aria-label="连续写作补充说明" maxLength={10000} placeholder="说明关键情节或处理意见；已有正文待审稿可在下方审阅后继续。" value={clarification} onChange={(e) => setClarification(e.target.value)} /></label>}
      </div>}
      <div className="toolbar">
        {job.status === "running" && <button disabled={pending} onClick={() => void act("writing.pause")}>暂停任务</button>}
        {resumable && budgetStopped(job.error) && job.tokenBudget < MAX_WRITING_TOKEN_BUDGET && <button disabled={pending || otherBusy || !validBudget} onClick={() => void act("writing.resume", true)}>增加本次调用额度并继续</button>}
        {resumable && <button disabled={pending || otherBusy || !validBudget} onClick={() => void act("writing.resume")}>继续任务</button>}
        {!["completed", "cancelled"].includes(job.status) && <button disabled={pending} onClick={() => void act("writing.cancel")}>取消任务</button>}
        {latestChapter && <button onClick={() => openChapter(latestChapter)}>查看最新正文</button>}
        {job.revisionJobIds.length > 0 && <button onClick={() => document.querySelector<HTMLElement>('[aria-label="Agent 改稿任务"]')?.scrollIntoView({ block: "nearest" })}>查看待审稿</button>}
      </div>
    </section>
  );
}
