import { useEffect, useState } from "react";
import type { AppState } from "../shared/types";
import type { WritingJob } from "../shared/writing";
import type { RevisionJob } from "../shared/revision";
import type { Run } from "./api";
import type { Flush } from "./editing";
import { ParagraphChanges } from "./revisions";

/** Writing-created candidates contain one chapter; review it where the writer stopped. */
export function WritingDrafts({ job, state, run, flush, disabled }: {
  job: WritingJob; state: AppState; run: Run; flush: Flush; disabled: boolean;
}) {
  const drafts = (state.revisionJobs ?? []).filter(r => job.revisionJobIds.includes(r.id) &&
    (r.candidatePendingCount ?? r.candidates.filter(c => c.status === "pending").length) > 0);
  const selected = drafts[0];
  const [detail, setDetail] = useState<RevisionJob>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setDetail(undefined); setError("");
    if (selected) void window.novel.revisionJob(selected.id).then(value => {
      if (current) setDetail(value);
    }).catch(() => { if (current) setError("暂时无法读取修改预览，请重新读取。"); });
    return () => { current = false; };
  }, [selected?.id, selected?.revision, refresh]);
  if (!selected) return null;
  const candidate = detail?.id === selected.id ? detail.candidates.find(c => c.status === "pending") : undefined;
  const stale = !!candidate && state.chapters.find(c => c.id === candidate.chapterId)?.revision !== candidate.sourceRevision;
  async function adopt() {
    if (!candidate || stale || busy) return;
    setBusy(true); setError("");
    try {
      if (!(await flush())) return;
      await run({type:"revision.accept",id:selected.id,chapterIds:[candidate.chapterId]});
      // Only continue after the last proposal. The main process rechecks every source.
      if (drafts.length === 1 && job.status !== "running" && job.status !== "completed")
        await run({type:"writing.resume",id:job.id});
    } catch (e) { setError(e instanceof Error ? e.message : "修改未能采用，原稿仍保留。"); }
    finally { setBusy(false); }
  }
  async function discardAndRecheck() {
    if (!candidate || busy) return;
    setBusy(true); setError("");
    try {
      if (!(await flush())) return;
      await run({type:"revision.reject",id:selected.id,chapterIds:[candidate.chapterId]});
      if (drafts.length === 1 && job.status !== "running" && job.status !== "completed")
        await run({type:"writing.resume",id:job.id});
    } catch (e) { setError(e instanceof Error ? e.message : "重新检查未能开始，原稿仍保留。"); }
    finally { setBusy(false); }
  }
  return <section id={`writing-drafts-${job.id}`} className="writing-draft-preview" aria-label="修改预览">
    <h4>已有正文的修改 · {drafts.length} 章待查看</h4>
    <p>先看具体改动，再一键采用。原稿保留在版本历史中，可随时恢复。</p>
    {error && <p role="alert">{error}<button onClick={() => setRefresh(n => n + 1)}>重新读取</button></p>}
    {!candidate ? <p>正在读取修改预览…</p> : <>
      <strong>{candidate.title}</strong>
      {stale && <p role="status">原文已有更新，这份修改方案已过期。请放弃此修改，按当前正文重新检查。</p>}
      <ParagraphChanges before={candidate.baseContent} after={candidate.content} />
      <div className="toolbar">
        <button className="primary" disabled={busy || disabled || stale} onClick={() => void adopt()}>{busy ? "正在处理…" : "采用修改并继续"}</button>
        <button disabled={busy || disabled} onClick={() => void discardAndRecheck()}>放弃修改，重新检查</button>
      </div>
    </>}
  </section>;
}
