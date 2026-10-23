import { createHash } from "node:crypto";
import type { AppState, Chapter, Note } from "../shared/types";
import type { StoryRecord, StoryRecordView } from "../shared/story-state";
import type { WritingJob } from "../shared/writing";
import type { ContextDocument } from "./context";

export const chapterDigest = (chapter: Chapter) =>
  chapter.contentHash ?? createHash("sha256").update(chapter.content).digest("hex");

export function storyViews(records: StoryRecord[], chapters: Chapter[], notes: Note[]): StoryRecordView[] {
  const cs = new Map(chapters.map(c => [c.id, { ...c, contentHash: chapterDigest(c) }]));
  const ns = new Map(notes.map(n => [n.id, n]));
  return records.map(r => {
    const needsReview = r.evidence.some(e => {
      const c = cs.get(e.chapterId);
      return !c || c.projectId !== r.projectId || c.revision !== e.revision ||
        c.contentHash !== e.contentHash || c.ordinal !== e.ordinal;
    }) || !!r.entityNoteId && (!ns.has(r.entityNoteId) ||
      ns.get(r.entityNoteId)!.revision !== r.entityRevision || !!ns.get(r.entityNoteId)!.archived);
    const stable = r.status === "confirmed" && r.statement === "fact" && !r.archived &&
      !needsReview && r.evidence.every(e => {
        const c = cs.get(e.chapterId);
        return c?.status === "confirmed" && !c.needsReview;
      });
    return { ...r, history: [], needsReview, stable, sourceLabels: r.evidence.map(e =>
      `第${e.ordinal}章 · ${cs.get(e.chapterId)?.title ?? "已移除"} · 版本${e.revision}`) };
  });
}

const position = (r: StoryRecord) => r.evidence.at(-1)?.ordinal ?? 0;
// A clue's name identifies its lifecycle. Character binding is only an association.
const key = (r: StoryRecord) => [r.kind,
  r.kind === "foreshadowing" ? r.subject.trim() : r.entityNoteId ?? r.subject.trim(),
  r.attribute.trim()].join("\0");
const byStoryPosition = (a: StoryRecord, b: StoryRecord) => position(b) - position(a) ||
  (a.evidence.at(-1)?.chapterId === b.evidence.at(-1)?.chapterId
    ? (b.evidence.at(-1)?.revision ?? 0) - (a.evidence.at(-1)?.revision ?? 0) : 0) ||
  (b.evidence.at(-1)?.end ?? 0) - (a.evidence.at(-1)?.end ?? 0) ||
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

export function acceptedStory(records: StoryRecord[], before = Infinity): StoryRecord[] {
  return records.flatMap(r => {
    if (r.archived) return [];
    const accepted = r.accepted ?? (r.status === "confirmed" ? r : undefined);
    if (accepted?.evidence.every(e => e.ordinal < before)) return [{ ...accepted, history: [] }];
    if (accepted) {
      const previous = [...r.history].reverse().find(h =>
        h.status === "confirmed" && h.evidence.every(e => e.ordinal < before));
      if (previous) return [{ ...previous, history: [] }];
    }
    return [];
  });
}

/** Keep auto references separate from accepted author facts, and retain stale
 * latest records as blockers so an earlier state cannot silently reappear. */
export function referencedStory(records: StoryRecord[], chapters: Chapter[], notes: Note[], jobs: WritingJob[], before = Infinity): StoryRecordView[] {
  const accepted = storyViews(acceptedStory(records, before), chapters, notes);
  const byId = new Map(jobs.map(j => [j.id, j]));
  const automatic = storyViews(records, chapters, notes).filter(r => {
    const job = r.origin.kind === "writing" && r.origin.id ? byId.get(r.origin.id) : undefined;
    return ["candidate", "rejected"].includes(r.status) && !r.accepted && !r.archived && r.evidence.length > 0 &&
      r.evidence.every(e => e.ordinal < before) && job?.projectId === r.projectId && job.autoMaterials && job.status === "completed" &&
      job.chapters.some(ch => ch.chapterId === r.evidence.at(-1)!.chapterId && ch.checkedRevision !== undefined);
  }).map(r => {
    const checked = byId.get(r.origin.id!)!.chapters.some(ch => ch.chapterId === r.evidence.at(-1)!.chapterId && ch.checkedRevision === r.evidence.at(-1)!.revision);
    return { ...r, automatic: true, needsReview: r.needsReview || !checked, stable: checked && r.status !== "rejected" && !r.needsReview && r.statement === "fact" };
  });
  // At the same story position the author's explicit choice takes precedence.
  return [...accepted, ...automatic.filter(r => !accepted.some(a => key(a) === key(r) && position(a) >= position(r)))];
}

function latestFacts(views: StoryRecordView[], before: number, foreshadowing: boolean) {
  const eligible = views.filter(r => !r.archived && (r.status === "confirmed" || r.automatic) &&
    r.statement === "fact" && (r.kind === "foreshadowing") === foreshadowing &&
    r.evidence.every(e => e.ordinal < before)).sort(byStoryPosition);
  // Select before validating: a changed latest source must block, never revive its predecessor.
  const latest = [...new Map(eligible.slice().reverse().map(r => [key(r), r])).values()];
  return { current: latest.filter(r => r.stable), blockedCount: latest.filter(r => !r.stable).length };
}
export function currentStory(views: StoryRecordView[], before = Infinity) {
  return latestFacts(views, before, false);
}
export function currentForeshadowing(views: StoryRecordView[], before = Infinity) {
  return latestFacts(views, before, true);
}
export interface StoryStamp { beforeOrdinal: number; writingJobId?: string; digest: string }

function selected(state: AppState, beforeOrdinal: number, writingJobId?: string) {
  const views = storyViews(state.storyRecords ?? [], state.chapters, state.notes);
  const accepted = referencedStory(state.storyRecords ?? [], state.chapters, state.notes, state.writingJobs ?? [], beforeOrdinal);
  const stable = currentStory(accepted, beforeOrdinal).current;
  const foreshadowing = currentForeshadowing(accepted, beforeOrdinal).current;
  const temporary = writingJobId ? views.filter(r => r.status === "candidate" && !r.archived &&
    !r.needsReview && r.statement === "fact" && r.origin.kind === "writing" &&
    r.origin.id === writingJobId && r.evidence.every(e => e.ordinal < beforeOrdinal)) : [];
  return [...new Map([...temporary, ...stable, ...foreshadowing].map(r => [r.id, r])).values()].sort(byStoryPosition).slice(0, 20);
}

export function storyContext(state: AppState, projectId: string, beforeOrdinal: number,
  writingJobId?: string): { documents: ContextDocument[]; stamp: StoryStamp } {
  const scoped = { ...state, storyRecords: (state.storyRecords ?? []).filter(r => r.projectId === projectId) };
  const records = selected(scoped, beforeOrdinal, writingJobId);
  const documents = records.flatMap(r => r.evidence.map(e => ({
    storyRecordId: r.id, source: { kind: "chapter" as const, id: e.chapterId, revision: e.revision },
    text: e.quote,
    label: `第${e.ordinal}章 · ${r.automatic ? "正文自动整理，供写作参考" : r.origin.kind === "writing" && r.status === "candidate" ? "本批临时状态，未采纳" : "作者确认状态"}：${r.subject}/${r.attribute}=${r.value}${r.foreshadowingStage ? `；伏笔${r.foreshadowingStage}` : ""}（元信息，非原文）`,
  })));
  const digest = createHash("sha256").update(JSON.stringify(records.map(r =>
    [r.id, r.revision, r.status, r.evidence]))).digest("hex");
  return { documents, stamp: { beforeOrdinal, ...(writingJobId ? { writingJobId } : {}), digest } };
}
export function storyStampCurrent(state: AppState, projectId: string, stamp: StoryStamp) {
  return storyContext(state, projectId, stamp.beforeOrdinal, stamp.writingJobId).stamp.digest === stamp.digest;
}
