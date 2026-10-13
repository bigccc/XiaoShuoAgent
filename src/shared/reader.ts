import type { Chapter, ChapterVersion, ID, RecordMeta } from "./types";

export interface TextSelection {
  chapterId: ID;
  revision: number;
  start: number;
  end: number;
  quote: string;
}
export interface ReadingAnnotation extends RecordMeta {
  contentHash?: string;
  chapterId: ID;
  anchor: TextSelection;
  text: string;
  status: "open" | "resolved";
}
export interface ReadingReview {
  contentHash?: string;
  chapterId: ID;
  revision: number;
  versionId: ID;
  reviewedAt: string;
}
export interface ReadingVolume {
  id: ID;
  title: string;
  fromOrdinal: number;
  toOrdinal: number;
}
export interface ReadingWorkspace extends RecordMeta {
  projectId: ID;
  annotations: ReadingAnnotation[];
  reviews: ReadingReview[];
  volumes: ReadingVolume[];
  position?: { chapterId: ID; offset: number; mode: "reading" | "review" };
}
export type ReaderCommand =
  | {
      type: "reading.annotate";
      projectId: ID;
      selection: TextSelection;
      text: string;
    }
  | {
      type: "reading.annotationStatus";
      projectId: ID;
      id: ID;
      status: "open" | "resolved";
    }
  | { type: "reading.review"; projectId: ID; chapterId: ID; revision: number }
  | {
      type: "reading.position";
      projectId: ID;
      chapterId: ID;
      offset: number;
      mode: "reading" | "review";
    }
  | {
      type: "reading.volumeSave";
      projectId: ID;
      id?: ID;
      title: string;
      fromOrdinal: number;
      toOrdinal: number;
    }
  | { type: "reading.volumeDelete"; projectId: ID; id: ID };
export interface SearchMatch {
  chapterId: ID;
  ordinal: number;
  title: string;
  revision: number;
  start: number;
  end: number;
  excerpt: string;
}
export interface SearchResult {
  matches: SearchMatch[];
  total: number;
  nextOffset: number | null;
}

/** A changed source can only relocate a quote when it occurs exactly once. */
export function locateSelection(
  content: string,
  selection: TextSelection,
  revision?: number,
): { start: number; end: number } | null {
  if (
    !Number.isSafeInteger(selection.start) ||
    !Number.isSafeInteger(selection.end) ||
    selection.start < 0 ||
    selection.end <= selection.start ||
    !selection.quote ||
    selection.end - selection.start !== selection.quote.length
  )
    return null;
  if (revision === selection.revision) {
    return content.slice(selection.start, selection.end) === selection.quote
      ? { start: selection.start, end: selection.end }
      : null;
  }
  const start = content.indexOf(selection.quote);
  // Advance one character, so overlapping duplicate occurrences are ambiguous too.
  if (start < 0 || content.indexOf(selection.quote, start + 1) >= 0)
    return null;
  return { start, end: start + selection.quote.length };
}

export type ReadingReviewStatus = "unreviewed" | "reviewed" | "needs-review";
export function reviewStatus(
  chapter: Pick<Chapter, "id" | "content"> &
    Partial<Pick<Chapter, "contentHash" | "contentLoaded">>,
  review?: ReadingReview,
  baseline?: Pick<ChapterVersion, "id" | "chapterId" | "content">,
): ReadingReviewStatus {
  if (!review || review.chapterId !== chapter.id) return "unreviewed";
  if (baseline) {
    if (baseline.id !== review.versionId || baseline.chapterId !== chapter.id)
      return "needs-review";
    if (chapter.contentLoaded !== false)
      return baseline.content === chapter.content ? "reviewed" : "needs-review";
  }
  if (chapter.contentHash && review.contentHash)
    return chapter.contentHash === review.contentHash
      ? "reviewed"
      : "needs-review";
  return "needs-review";
}
