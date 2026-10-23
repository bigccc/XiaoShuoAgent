import { CostSummary } from "./billing";
import { useEffect, useState } from "react";
import type { AppState } from "../shared/types";
import {
  paragraphDiff,
  type RevisionCandidate,
  type RevisionJob,
} from "../shared/revision";
import type { Run } from "./api";
import { authorError } from "./author-experience";

export function ParagraphChanges({
  before,
  after,
}: {
  before: string;
  after: string;
}) {
  return (
    <div className="paragraph-changes">
      {paragraphDiff(before, after).map((p, i) => (
        <div key={i} className={"diff-" + p.kind}>
          <small>
            {p.kind === "added"
              ? "新增"
              : p.kind === "removed"
                ? "删除"
                : "保留"}
          </small>
          <pre>{p.text || "（空段）"}</pre>
        </div>
      ))}
    </div>
  );
}
const names: Record<RevisionJob["status"], string> = {
  running: "正在改稿",
  paused: "已暂停",
  interrupted: "等待手动续跑",
  cancelled: "已取消",
  failed: "失败",
  "awaiting-author": "等待审阅",
  completed: "已完成",
};
export function Revisions({
  state,
  projectId,
  run,
  excludeJobIds = [],
}: {
  state: AppState;
  projectId: string;
  run: Run;
  excludeJobIds?: string[];
}) {
  const jobs = (state.revisionJobs ?? []).filter(
    (j) => j.projectId === projectId && !excludeJobIds.includes(j.id),
  );
  const [chosen, setChosen] = useState(""),
    [detail, setDetail] = useState<RevisionJob>(),
    [error, setError] = useState("");
  const [clarification, setClarification] = useState("");
  const [candidatePage, setCandidatePage] = useState(0);
  const selected = jobs.find((j) => j.id === chosen) ?? jobs.at(-1);
  useEffect(() => {
    let current = true;
    setDetail(undefined);
    setError("");
    if (selected)
      void window.novel
        .revisionJob(selected.id, candidatePage * 20, 20)
        .then((j) => {
          if (current) setDetail(j);
        })
        .catch(() => {
          if (current) setError("无法读取待审稿，请重试。");
        });
    return () => {
      current = false;
    };
  }, [selected?.id, selected?.revision, candidatePage]);
  useEffect(() => setCandidatePage(0), [selected?.id]);
  if (!jobs.length) return null;
  const job = detail ?? selected!;
  const candidateCount = job.candidateCount ?? job.candidates.length;
  const pendingCount =
    job.candidatePendingCount ??
    job.candidates.filter((c) => c.status === "pending").length;
  function relatedText(candidate: RevisionCandidate) {
    return (candidate.dependsOnChapterIds ?? [])
      .map((id) => {
        const chapter = state.chapters.find((c) => c.id === id);
        const dependency = job.candidates.find((c) => c.chapterId === id);
        return `第${chapter?.ordinal ?? "?"}章${chapter ? `（${chapter.title}）` : ""}${dependency?.status === "accepted" ? "已采纳" : dependency?.status === "rejected" ? "已拒绝" : "待审稿"}`;
      })
      .join("、");
  }
  function dependencyBlocked(candidate: RevisionCandidate) {
    return (candidate.dependsOnChapterIds ?? []).some((id) => {
      const dependency = job.candidates.find((c) => c.chapterId === id);
      return dependency && dependency.status !== "accepted";
    });
  }
  const act = (
    type:
      | "revision.pause"
      | "revision.resume"
      | "revision.cancel"
      | "revision.accept"
      | "revision.reject",
    chapterIds?: string[],
    includeMaterials = false,
  ) =>
    void run({
      type,
      id: job.id,
      ...(chapterIds ? { chapterIds } : {}),
      ...(includeMaterials ? { includeMaterials: true } : {}),

    }).catch(() => {});
  return (
    <section className="revision-jobs" aria-label="Agent 改稿任务">
      <h3>改稿与待审稿</h3>
      <CostSummary ownerId={job.id} />
      <select
        aria-label="查看改稿任务"
        value={job.id}
        onChange={(e) => setChosen(e.target.value)}
      >
        {jobs.map((j) => (
          <option key={j.id} value={j.id}>
            {names[j.status]} · {j.chapterIds.length} 章 · {j.text.slice(0, 30)}
          </option>
        ))}
      </select>
      <p>
        <strong>{names[job.status]}</strong> · 已检查{" "}
        {job.checkedChapterIds.length} / {job.chapterIds.length} 章
      </p>
      <p className="muted">
        关联资料已完整检查 {job.checkedNoteIds?.length ?? 0} /{" "}
        {job.noteSources?.length ??
          state.notes.filter((n) => n.projectId === projectId && !n.archived)
            .length}{" "}
        份
      </p>
      <progress
        value={job.checkedChapterIds.length}
        max={job.chapterIds.length || 1}
      />
      <details className="technical-details"><summary>技术详情</summary><p className="muted">
        用量 {job.usage?.totalTokens?.toLocaleString() ?? "未知"} Token
        {job.usage?.estimated ? "（估算）" : ""}
      </p></details>
      <div className="toolbar">
        {job.status === "running" ? (
          <button onClick={() => act("revision.pause")}>暂停</button>
        ) : (
          ["paused", "interrupted", "failed"].includes(job.status) && (
              <button onClick={() => act("revision.resume")}>继续完成</button>
          )
        )}
        {!["completed", "cancelled"].includes(job.status) && (
          <button onClick={() => act("revision.cancel")}>取消任务</button>
        )}
      </div>
      {job.status === "awaiting-author" &&
        job.checkedChapterIds.length < job.chapterIds.length && (
          <div className="revision-clarification">
            <label>
              需要作者判断
              <textarea
                aria-label="改稿澄清回复"
                value={clarification}
                onChange={(e) => setClarification(e.target.value)}
                placeholder="说明关键情节或选择，Agent 再继续"
              />
            </label>
            <button
              disabled={!clarification.trim()}
              onClick={() =>
                void run({
                  type: "revision.resume",
                  id: job.id,
                  text: clarification,
                })
                  .then(() => setClarification(""))
                  .catch(() => {})
              }
            >
              回复并继续改稿
            </button>
          </div>
        )}
      {job.reply && <p>{authorError(job.reply)}</p>}
      {(job.error || error) && <p className="error">{authorError(job.error || error || "")}</p>}
      {job.warnings.map((w, i) => (
        <p className="hint warn" key={i}>
          {w}
        </p>
      ))}
      {detail && (
        <>
          <p>
            待审 {pendingCount} 章 · 未检查{" "}
            {job.chapterIds.length - job.checkedChapterIds.length} 章
          </p>
          <div className="toolbar">
            <button
              className="primary"
              disabled={!pendingCount}
              onClick={() => act("revision.accept")}
            >
              采纳剩余正文
            </button>
            <button
              disabled={!pendingCount}
              onClick={() => act("revision.accept", undefined, true)}
            >
              整批采纳及关联资料
            </button>
            <button
              className="danger"
              disabled={!pendingCount}
              onClick={() => act("revision.reject")}
            >
              整批拒绝
            </button>
          </div>
          {job.candidates.map((c) => (
            <details key={c.chapterId} className="revision-candidate">
              <summary>
                {c.title} ·{" "}
                {
                  { pending: "待审", accepted: "已采纳", rejected: "已拒绝" }[
                    c.status
                  ]
                }
              </summary>
              {!!c.dependsOnChapterIds?.length && (
                <p className="hint warn">
                  与{relatedText(c)}
                  有关。请先采纳关联章，或使用「采纳剩余正文」整批处理；关联稿已拒绝时须重新生成。
                </p>
              )}
              <ParagraphChanges before={c.baseContent} after={c.content} />
              {c.status === "pending" && (
                <div className="toolbar">
                  <button
                    className="primary"
                    disabled={dependencyBlocked(c)}
                    onClick={() => act("revision.accept", [c.chapterId])}
                  >
                    采纳本章
                  </button>
                  <button
                    className="danger"
                    onClick={() => act("revision.reject", [c.chapterId])}
                  >
                    拒绝本章
                  </button>
                </div>
              )}
            </details>
          ))}
          {candidateCount > 20 && (
            <div className="toolbar">
              <button
                disabled={!candidatePage}
                onClick={() => setCandidatePage((p) => p - 1)}
              >
                上一页待审稿
              </button>
              <span>
                {candidatePage + 1} / {Math.ceil(candidateCount / 20)}
              </span>
              <button
                disabled={(candidatePage + 1) * 20 >= candidateCount}
                onClick={() => setCandidatePage((p) => p + 1)}
              >
                下一页待审稿
              </button>
            </div>
          )}
          {(job.notes.length > 0 || job.projectPatch) && (
            <details>
              <summary>
                关联资料 ·{" "}
                {
                  { pending: "待处理", accepted: "已采纳", rejected: "已拒绝" }[
                    job.materialsStatus
                  ]
                }
              </summary>
              {job.notes.map((n, i) => (
                <article key={i}>
                  <h4>{n.title}</h4>
                  <pre>{n.body}</pre>
                </article>
              ))}
              {job.projectPatch && (
                <pre>{JSON.stringify(job.projectPatch, null, 2)}</pre>
              )}
              <p className="muted">
                相关章节处理后集中采纳，来源冲突会保留提示。
              </p>
              <div className="toolbar">
                <button onClick={() => act("revision.accept", [], true)}>
                  采纳关联资料
                </button>
                <button onClick={() => act("revision.reject", [], true)}>
                  拒绝关联资料
                </button>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
