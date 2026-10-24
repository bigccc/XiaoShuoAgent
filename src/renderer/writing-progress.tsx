import { CostSummary } from "./billing";
import { useEffect, useState } from "react";
import type { AppState } from "../shared/types";
import { type WritingJob } from "../shared/writing";
import type { Run } from "./api";
import type { Flush } from "./editing";
import {
  authorError,
  budgetStopped,
} from "./author-experience";
import { ContextReferences } from "./context-references";
import { WritingDrafts } from "./writing-drafts";

const statusNames: Record<WritingJob["status"], string> = {
  running: "正在推进",
  paused: "已暂停",
  interrupted: "等待手动续跑",
  cancelled: "已取消",
  failed: "本轮未完成",
  "awaiting-author": "仍有待处理事项",
  completed: "任务已完成",
};
const phaseNames: Record<WritingJob["phase"], string> = {
  planning: "准备逐章计划",
  writing: "生成正文",
  checking: "检查正文",
  revising: "修订正文",
  reviewing: "跨章复核",
  done: "本轮已结束",
};
const issueNames: Record<WritingJob["issues"][number]["category"], string> = {
  character: "人物",
  timeline: "时间线",
  plot: "情节",
  world: "世界设定",
  knowledge: "信息认知",
  foreshadowing: "伏笔",
  style: "文风",
  pacing: "节奏",
  length: "篇幅",
};

export function WritingProgress({
  job,
  state,
  run,
  flush,
  otherBusy,
  openChapter,
  openStoryState,
  openProfiles,
}: {
  job: WritingJob;
  state: AppState;
  run: Run;
  flush: Flush;
  otherBusy: boolean;
  openChapter: (id: string) => void;
  openStoryState: () => void;
  openProfiles: () => void;
}) {
  const [profileId, setProfileId] = useState(job.profileId ?? "");
  const [clarification, setClarification] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sceneRecovery, setSceneRecovery] = useState<{
    chapterId: string; needsReview: boolean; automatic: boolean; failed?: boolean;
  }>();
  const [sceneRefresh, setSceneRefresh] = useState(0);
  const hasBlockingIssues = job.issues.some(
    (issue) => issue.impact === "blocking",
  );
  const [issuesOpen, setIssuesOpen] = useState(
    job.status !== "running" && hasBlockingIssues,
  );
  const [issueDetail, setIssueDetail] = useState<{
    revision: number;
    issues: WritingJob["issues"];
  }>();
  const [issueReadError, setIssueReadError] = useState(false);
  const [issueRefresh, setIssueRefresh] = useState(0);
  useEffect(() => {
    setIssuesOpen(job.status !== "running" && hasBlockingIssues);
  }, [job.id, job.status, hasBlockingIssues]);
  useEffect(() => {
    if (!issuesOpen || !job.issues.length) return;
    let active = true;
    setIssueReadError(false);
    void window.novel
      .writingIssues(job.id)
      .then((detail) => {
        if (active) setIssueDetail(detail);
      })
      .catch(() => {
        if (active) setIssueReadError(true);
      });
    return () => {
      active = false;
    };
  }, [job.id, job.revision, issuesOpen, job.issues.length, issueRefresh]);
  const saved = job.chapters.filter(
    (c) => c.chapterId && (c.existing || c.status !== "pending"),
  );
  const checked = job.chapters.filter((c) => {
    if (c.checkedRevision === undefined) return c.status === "checked";
    const current = state.chapters.find(
      (chapter) => chapter.id === c.chapterId,
    );
    return !!current && current.revision === c.checkedRevision;
  });
  const needsReview = job.chapters.filter(
    (c) => c.status === "needs-review",
  ).length;
  const resumable = [
    "paused",
    "interrupted",
    "failed",
    "awaiting-author",
  ].includes(job.status);
  const selectedProfile = state.profiles.some((p) => p.id === profileId)
    ? profileId
    : "";
  const latestChapter = saved.at(-1)?.chapterId;
  const blocking = job.issues.filter((i) => i.impact === "blocking").length;
  const staleCheck =
    job.status === "completed" && job.chapters.some(c => c.checkedRevision !== undefined && state.chapters.find(ch => ch.id === c.chapterId)?.revision !== c.checkedRevision);
  const stopped = ["failed", "paused", "interrupted"].includes(job.status);
  const checkPhase = ["checking", "reviewing"].includes(job.phase);
  const needsDecision =
    job.status === "awaiting-author" &&
    !!job.reply &&
    job.phase !== "done" &&
    job.mode !== "quick";
  const currentError = error || (stopped ? (job.error ?? "") : "");
  const connectionProblem =
    /密钥|鉴权|API 地址|连接失败|连接未成功|先配置|重新配置|模型.*(?:不存在|配置)|KEY_PROTECTION|AUTH|CONFIG|NETWORK/.test(
      currentError,
    );
  const storageProblem = /磁盘|存储|文件权限/.test(currentError);
  const sceneProblem = stopped && /场景.*(?:依据|来源|计划).*改变/.test(currentError);
  const sceneChapter = state.chapters.find(c => c.id === job.chapters[job.cursor]?.chapterId);
  const sceneNeedsReview = !!sceneRecovery?.needsReview && !sceneRecovery.automatic;
  const sceneBlocked = sceneProblem && (!sceneRecovery || sceneRecovery.failed || sceneNeedsReview);
  useEffect(() => {
    if (!sceneProblem || !sceneChapter) { setSceneRecovery(undefined); return; }
    let active = true;
    setSceneRecovery(undefined);
    void window.novel.sceneWorkspace(sceneChapter.id).then(value => {
      if (active) setSceneRecovery({chapterId:sceneChapter.id,needsReview:value.needsReview,automatic:value.plan?.origin === "writing"});
    }).catch(() => {
      if (active) setSceneRecovery({chapterId:sceneChapter.id,needsReview:true,automatic:false,failed:true});
    });
    return () => { active = false; };
  }, [sceneProblem, sceneChapter?.id, job.revision, state, sceneRefresh]);
  const nextStep = sceneProblem
    ? !sceneRecovery
      ? "正在核对本章场景卡，已保存正文仍保留。"
      : sceneRecovery.failed
        ? "暂时无法读取场景卡状态。请重新读取，或打开本章场景查看；已保存正文仍保留。"
        : sceneNeedsReview
          ? "本章场景卡依据已变化。请打开“本章场景”，核对并保存场景计划后，再继续；已保存正文仍保留。"
          : "场景卡状态已核对。点击“重新检查并继续”，将按最新正文处理；过期的自动场景卡不会作为依据。"
    : staleCheck
    ? "正文已有修改，上次检查结果只适用于当时版本，请重新核对改动。"
    : job.status === "running"
      ? "正在继续推进；已保存的章节可以随时查看。"
      : stopped
        ? budgetStopped(job.error)
          ? "旧版本预算暂停，已有进度保留。点击继续即可恢复，无需追加预算。"
          : job.status === "failed"
            ? checkPhase
              ? "本次检查未完成，已保存的正文仍保留。可继续任务重试检查。"
              : "本次写作未完成，已保存的进度仍保留。可继续任务重试。"
            : "任务已暂停，已保存的正文仍保留。点击继续任务，从当前进度接着处理。"
        : job.status === "cancelled"
          ? "任务已取消，已保存的正文仍可查看和编辑。"
          : blocking
            ? `需要先处理下方 ${blocking} 项影响后文的问题，再继续本轮任务。`
            : needsDecision
              ? "需要你确认下面的创作方向，补充说明后再继续。"
              : job.mode === "quick" && job.phase === "checking"
                ? "试写草稿已保存，尚未完成一致性检查。可先看稿，或继续认真定稿。"
                : job.status === "completed"
                  ? "本轮写作与检查已完成，可以查看正文，也可以继续写下一批。"
                  : job.phase === "done"
                    ? job.issues.length ||
                      needsReview ||
                      job.revisionJobIds.length
                      ? "本轮正文已保存，仍有局部建议或待审稿需要查看；可以继续写下一批。"
                      : "本轮写作与检查已完成，可以查看正文，也可以继续写下一批。"
                    : "请查看已有正文和待审稿，再继续本轮任务。";
  const diagnostics = [
    ...new Set(
      [...job.warnings, job.error, job.reply].filter((s): s is string => !!s),
    ),
  ];
  const storyNotices = job.warnings.some((w) =>
    /故事状态|状态候选|候选引用|伏笔计划/.test(w),
  );
  const sceneNotices = job.warnings.some((w) => /场景/.test(w));
  const coverageNotices = job.warnings.some((w) =>
    /上下文.*(?:不足|截断)|未完整纳入|已省略|覆盖不足|未纳入相关旧章|表达参考未纳入/.test(
      w,
    ),
  );
  const visibleIssues =
    issueDetail?.revision === job.revision ? issueDetail.issues : job.issues;
  const budgetProblem = resumable && budgetStopped(job.error);
  const pendingDrafts = (state.revisionJobs ?? []).some(r => job.revisionJobIds.includes(r.id) && (r.candidatePendingCount ?? r.candidates.filter(c => c.status === "pending").length) > 0);
  const currentProgress = job.chapters[job.cursor];
  const currentChapter = state.chapters.find(chapter => chapter.id === currentProgress?.chapterId);
  const currentBlocking = job.issues.some(issue => issue.impact === "blocking" && issue.chapterId === currentProgress?.chapterId);
  const existingReview = job.reviewOnly === true && currentProgress?.existing === true && currentBlocking && !!currentChapter;
  const checkedCurrent = !!currentChapter && currentProgress?.checkedRevision === currentChapter.revision;
  const existingReviewChanged = existingReview && !checkedCurrent;
  const existingReviewAttempted = existingReview && checkedCurrent && currentProgress?.status === "needs-review" && (currentProgress.authorRevisionRounds ?? 0) > 0 && !pendingDrafts;
  const existingReviewLimited = existingReview && (currentProgress?.revisionRounds ?? 0) >= 2;
  const draftsArePrimary = job.status !== "running" && !connectionProblem && !sceneBlocked && pendingDrafts && (blocking > 0 || job.phase === "done" && !budgetProblem && !needsDecision);
  const actionMessage = draftsArePrimary ? "请查看下方修改预览，点击采用即可继续，原稿保留。" : nextStep;
  const readIsPrimary = !!latestChapter && job.status !== "running" && !connectionProblem && !sceneBlocked && !draftsArePrimary && !resumable;
  const showDrafts = () => document.getElementById(`writing-drafts-${job.id}`)?.scrollIntoView({block:"nearest"});
  async function act(
    type: "writing.pause" | "writing.resume" | "writing.cancel",
    decision?: string,
    recheck = false,
  ) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      if (type === "writing.resume") {
        if (!(await flush())) return;
      }
      await run({
        type,
        id: job.id,
        ...(type === "writing.resume"
          ? {
              ...(!recheck && decision && hasBlockingIssues ? {repair:true} : {}),
              ...(selectedProfile ? { profileId: selectedProfile } : {}),
              ...(!recheck && (decision ?? clarification).trim() ? { text: (decision ?? clarification).trim() } : {}),
            }
          : {}),
      });
      if (type === "writing.resume") setClarification("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未完成，请重试。");
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      className="writing-progress"
      aria-label="连续写作任务"
      aria-busy={pending}
    >
      <header>
        <div>
          <small>连续写作</small>
          <h3>
            第 {job.goal.startOrdinal}–{job.goal.endOrdinal} 章
          </h3>
        </div>
        <strong className={`writing-status writing-status-${job.status}`}>
          {staleCheck ? "正文有更新" : statusNames[job.status]}
        </strong>
      </header>
      <div className="writing-action-block">
        <div className="toolbar writing-main-actions" role="group" aria-label="当前任务操作">
          {job.status === "running" ? (
            <button className="primary" disabled={pending} onClick={() => void act("writing.pause")}>暂停任务</button>
          ) : connectionProblem ? (
            <button className="primary" onClick={openProfiles}>检查 AI 连接</button>
          ) : sceneBlocked ? (
            sceneRecovery?.failed ? <button className="primary" onClick={() => setSceneRefresh(n => n + 1)}>重新读取场景状态</button>
            : <button className="primary" disabled={!sceneRecovery || !sceneChapter} onClick={() => sceneChapter && openChapter(sceneChapter.id)}>{sceneRecovery && sceneChapter ? `查看第${sceneChapter.ordinal}章场景卡` : "正在核对场景卡…"}</button>
          ) : draftsArePrimary ? (
            <button className="primary" onClick={showDrafts}>查看修改预览</button>
          ) : needsDecision && !pendingDrafts ? null : budgetProblem ? (
            <button className="primary" disabled={pending || otherBusy} onClick={() => void act("writing.resume")}>{pending ? "正在继续…" : "继续完成"}</button>
          ) : resumable ? (
            <button className="primary" disabled={pending || otherBusy} onClick={() => void act("writing.resume")}>{pending ? "正在继续…" : sceneProblem ? "重新检查并继续" : job.mode === "quick" && job.phase === "checking" ? "继续认真定稿" : "继续完成"}</button>
          ) : latestChapter ? <button className="primary" onClick={() => openChapter(latestChapter)}>查看正文</button> : null}
          {latestChapter && !readIsPrimary && <button className="subtle" onClick={() => openChapter(latestChapter)}>查看正文</button>}
        </div>
      </div>
      <CostSummary ownerId={job.id} />
      <p className="writing-request">{job.text}</p>
      <p role="status">
        {phaseNames[job.phase]}
        {job.status === "running" && job.chapters[job.cursor]
          ? ` · 第 ${job.chapters[job.cursor].ordinal} 章`
          : ""}
      </p>
      <div className="writing-counts">
        <div>
          <span>
            已保存 {saved.length} / {job.chapters.length} 章
          </span>
          <progress
            aria-label="连续写作保存进度"
            value={saved.length}
            max={job.chapters.length || 1}
          />
        </div>
        <div>
          <span>
            已检查 {checked.length} / {job.chapters.length} 章
          </span>
          <progress
            aria-label="连续写作检查进度"
            value={checked.length}
            max={job.chapters.length || 1}
          />
        </div>
      </div>
      {job.status === "running" && <p className="muted">正文会自动保存，可以随时阅读。{checked.length < saved.length ? "正在检查已保存的章节。" : ""}</p>}
      {job.status === "completed" && !error ? (
        <p className="writing-conclusion" role="status">
          <strong>✓ {staleCheck ? "正文有更新" : statusNames[job.status]}</strong>
          {actionMessage}
        </p>
      ) : (
        <p
          className={
            job.status === "failed" || error ? "error" : "writing-next-step"
          }
          role={job.status === "failed" || error ? "alert" : "status"}
        >
          {connectionProblem
            ? "AI 连接需要处理。请先检查设置中的连接和密钥，再继续任务；已保存的正文仍保留。"
            : storageProblem
              ? "本次未能保存，请检查磁盘空间或文件权限，先备份已有内容再重试。"
              : error
                ? authorError(error)
                : actionMessage}
        </p>
      )}
      {needsDecision && !pendingDrafts && (
        <div className="writing-decision">
          <strong>集中确认处理方向</strong>
          <p>{job.authorQuestion ?? job.reply}</p>
          <p>{existingReviewLimited
            ? "本章已生成两轮修改预览，冲突仍未解决。请手动编辑后重新检查，不再重复生成。"
            : existingReviewAttempted
              ? "这个正文版本已经生成过修改预览。请补充新的处理意见再试，或手动编辑正文。"
              : existingReview
                ? "根据当前检查问题生成本章修改预览，保留有效原文和创作方向；采纳前不会改动原稿。"
                : "推荐保留已确认设定和前文事实，合并处理本章问题。可在下方补充意见，再点击“按推荐处理并继续”。"}</p>
          <label className="writing-decision-input">
            补充说明
            <textarea aria-label="连续写作补充说明" maxLength={4000} placeholder="说明关键情节或处理意见；已有正文待审稿请先审阅。" value={clarification} onChange={e => setClarification(e.target.value)} />
          </label>
          {existingReviewChanged ? (
            <button className="primary" disabled={pending || otherBusy} onClick={() => void act("writing.resume", undefined, true)}>{pending ? "正在检查…" : "重新检查已修改正文"}</button>
          ) : existingReviewLimited ? (
            <button className="primary" disabled={!currentChapter} onClick={() => currentChapter && openChapter(currentChapter.id)}>打开正文手动修改</button>
          ) : existingReviewAttempted ? (
            <button className="primary" disabled={pending || otherBusy || !clarification.trim()} onClick={() => void act("writing.resume", clarification.trim())}>{pending ? "正在处理…" : "按补充意见重新生成预览"}</button>
          ) : (
            <button className="primary" disabled={pending || otherBusy} onClick={() => void act("writing.resume", clarification.trim() || (existingReview
              ? "根据当前检查问题生成本章修改预览，只修正已证实的事实冲突，保留有效原文，不直接写入原稿。"
              : "保留已确认的人物设定、主线、结局及前文事实，合并修正本章全部已证实的事实冲突；只改本批新稿，不改作者已有正文。"))}>{pending ? "正在处理…" : existingReview ? "生成修改预览" : "按推荐处理并继续"}</button>
          )}
          {existingReview && !existingReviewChanged && !existingReviewLimited && <button disabled={!currentChapter} onClick={() => currentChapter && openChapter(currentChapter.id)}>手动修改正文</button>}
        </div>
      )}
      {pendingDrafts && <WritingDrafts job={job} state={state} run={run} flush={flush} disabled={pending || otherBusy || job.status === "running"} />}
      {coverageNotices && (
        <p className="writing-material-notice">
          本轮部分参考资料未完整纳入，建议核对前后衔接。具体范围可在技术详情中查看。
        </p>
      )}
      {job.issues.length > 0 && (
        <details
          className="writing-issues"
          open={issuesOpen}
          onToggle={(e) => setIssuesOpen(e.currentTarget.open)}
        >
          <summary>{job.issues.length} {hasBlockingIssues ? "项需要处理的问题" : "条写作建议 · 可稍后查看"}</summary>
          {issueReadError ? (
            <p>
              暂时无法读取原文依据。
              <button onClick={() => setIssueRefresh((n) => n + 1)}>
                重新读取依据
              </button>
            </p>
          ) : (
            issueDetail?.revision !== job.revision && (
              <p className="muted">正在读取原文依据…</p>
            )
          )}
          {visibleIssues.map((issue, index) => {
            const chapter = state.chapters.find(
              (c) => c.id === issue.chapterId,
            );
            const changed = issue.evidence.some((e) => {
              const current =
                e.source.kind === "chapter"
                  ? state.chapters.find((c) => c.id === e.source.id)
                  : e.source.kind === "note"
                    ? state.notes.find((n) => n.id === e.source.id)
                    : state.projects.find((p) => p.id === e.source.id);
              return !current || current.revision !== e.source.revision;
            });
            return (
              <article key={index}>
                <strong>
                  {chapter ? `第${chapter.ordinal}章 · ` : ""}
                  {issueNames[issue.category]} ·{" "}
                  {changed ? "原文已更新，等待复查" : issue.impact === "blocking"
                    ? "影响后文，需处理"
                    : "可选建议"}
                </strong>
                <p>{issue.reason}</p>
                {changed && (
                  <p className="muted">
                    相关原文已有修改，以下是上次检查依据；继续任务时会重新检查。
                  </p>
                )}
                {issue.evidence.map((evidence, evidenceIndex) => (
                  <blockquote key={evidenceIndex}>{evidence.quote}</blockquote>
                ))}
                {chapter ? (
                  <button onClick={() => openChapter(chapter.id)}>
                    查看第{chapter.ordinal}章
                  </button>
                ) : (
                  <button onClick={openStoryState}>查看故事资料</button>
                )}
              </article>
            );
          })}
        </details>
      )}
      {!!job.reviewNotes?.length && <details className="writing-issues">
        <summary>{job.reviewNotes.length} 条未证实的建议 · 可选查看</summary>
        <p>这些疑点缺少有效原文支持，未据此修改正文，也未将它们当成已经排除的问题。</p>
        {job.reviewNotes.map((note, index) => <p key={index}>{note}</p>)}
      </details>}
      <details className="writing-more">
        <summary>更多</summary>
      {(storyNotices || sceneNotices) && (
        <section
          className="writing-material-notice"
          aria-label="辅助资料整理记录"
        >
          <strong>资料整理记录 · 可稍后核对</strong>
          <p>
            曾有未更新或未采纳的辅助资料。正文保存情况见上方；资料是否已补齐，请在对应页面核对。
          </p>
          <div className="toolbar">
            {storyNotices && (
              <button onClick={openStoryState}>核对状态与伏笔</button>
            )}
            {sceneNotices && latestChapter && (
              <button onClick={() => openChapter(latestChapter)}>
                查看章节与场景卡
              </button>
            )}
          </div>
        </section>
      )}
        {resumable && <div className="writing-resume">
          <details>
            <summary>高级设置</summary>
            <label>
              续跑模型
              <select
                aria-label="连续写作续跑模型"
                value={selectedProfile}
                onChange={(e) => setProfileId(e.target.value)}
              >
                <option value="">沿用任务模型</option>
                {state.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.model}
                  </option>
                ))}
              </select>
            </label>
          </details>
        </div>}
      <details className="writing-budget writing-diagnostics">
        <summary>技术详情 · {diagnostics.length} 条记录</summary>
        <span>
          累计用量 {job.budgetUsed.toLocaleString()} Token
        </span>
        <small>
          {job.usage?.totalTokens == null
            ? "模型尚未报告用量"
            : `模型${job.usage.estimated ? "估算" : "已报告"}用量 ${job.usage.totalTokens.toLocaleString()} Token`}{" "}
          · {job.calls} 次请求
        </small>
        {((job.usage?.totalTokens == null && job.budgetUsed > 0) ||
          job.budgetUsed > (job.usage?.totalTokens ?? 0)) && (
          <small>包含未报告用量的估算，继续任务不会清零。</small>
        )}
        {(job.checkCacheHits !== undefined ||
          job.checkCacheMisses !== undefined) && (
          <p className="muted">
            复用已验证窗口 {job.checkCacheHits ?? 0} 段；本次新检查{" "}
            {job.checkCacheMisses ?? 0} 段。
          </p>
        )}
        <p className="muted">
          以下是本轮累计记录，包含已恢复的情况；请以上方当前结果为准。
        </p>
        <ul className="writing-diagnostic-log">
          {diagnostics.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
        <ContextReferences
          references={job.contextReferences}
          chapters={state.chapters}
          label="最近一次提供的远章原文"
          description={
            job.contextReferenceCall
              ? `来自第${job.contextReferenceCall.number}次请求：${job.contextReferenceCall.phase}${job.contextReferenceCall.ordinal ? ` · 第${job.contextReferenceCall.ordinal}章` : ""}。当前任务进度可能已推进。`
              : "历史记录未注明对应请求。"
          }
        />
      </details>
        <div className="toolbar">
          {connectionProblem && resumable && <button disabled={pending || otherBusy} onClick={() => void act("writing.resume")}>已调整连接，重试</button>}
          {job.revisionJobIds.length > 0 && !draftsArePrimary && <button onClick={showDrafts}>查看修改预览</button>}
          {!["completed", "cancelled"].includes(job.status) && <button className="subtle danger" disabled={pending} onClick={() => void act("writing.cancel")}>取消任务</button>}
        </div>
      </details>
    </section>
  );
}
