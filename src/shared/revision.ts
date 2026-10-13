import {validateSceneSource,type SceneSource} from "./scenes";
import { DomainError, validatePublicJson } from "./validation";
import type {
  ID,
  RecordMeta,
  ProjectFields,
  NoteType,
  TaskUsage,
} from "./types";
import type { TextSelection } from "./reader";

export const MAX_REVISION_TOKEN_BUDGET = 1_000_000_000;

export interface RevisionCandidate {
  chapterId: ID;
  sourceRevision: number;
  title: string;
  baseContent: string;
  baseTitle?: string;
  content: string;
  status: "pending" | "accepted" | "rejected";
  appliedRevision?: number;
  /** Other pending chapter proposals actually read while generating this candidate. */
  dependsOnChapterIds?: ID[];
}
export interface RevisionNoteProposal {
  id?: ID;
  sourceRevision?: number;
  type: NoteType;
  title: string;
  body: string;
}
export interface RevisionJob extends RecordMeta {
  sceneSource?:SceneSource;
  projectId: ID;
  profileId?: ID;
  text: string;
  scope: "selection" | "chapter" | "chapters" | "all";
  chapterIds: ID[];
  annotationIds: ID[];
  selection?: TextSelection;
  status:
    | "running"
    | "paused"
    | "interrupted"
    | "cancelled"
    | "failed"
    | "awaiting-author"
    | "completed";
  tokenBudget: number;
  usage: TaskUsage | null;
  calls: number;
  checkedChapterIds: ID[];
  candidates: RevisionCandidate[];
  /** IPC-only candidate paging metadata; never stored in portable jobs. */
  candidateCount?: number;
  candidatePendingCount?: number;
  candidateOffset?: number;
  notes: RevisionNoteProposal[];
  projectPatch?: Partial<
    Pick<ProjectFields, "background" | "genre" | "style" | "pace">
  >;
  sourceProjectRevision: number;
  sourceProjectDigest?: string;
  /** Planning documents read while producing a continuous-writing proposal. */
  sourceAuthoringDigest?: string;
  sourceProfileDigest?: string;
  chapterSources?: { chapterId: ID; revision: number; digest: string }[];
  referenceChapterSources?: {
    chapterId: ID;
    revision: number;
    digest: string;
  }[];
  noteSources?: { id: ID; revision: number; digest: string }[];
  checkedNoteIds?: ID[];
  warnings: string[];
  reply: string;
  error?: string;
  materialsStatus: "pending" | "accepted" | "rejected";
}
export type RevisionCommand =
  | {
      type: "revision.start";
      sceneSource?:SceneSource;
      projectId: ID;
      text: string;
      scope: RevisionJob["scope"];
      chapterIds?: ID[];
      selection?: TextSelection;
      annotationIds?: ID[];
      profileId?: ID;
      tokenBudget: number;
    }
  | {
      type: "revision.pause" | "revision.cancel" | "revision.resume";
      id: ID;
      tokenBudget?: number;
      text?: string;
    }
  | {
      type: "revision.accept" | "revision.reject";
      id: ID;
      chapterIds?: ID[];
      includeMaterials?: boolean;
    };

export interface ParagraphDiff {
  kind: "same" | "removed" | "added";
  text: string;
}
/** Bounded LCS on paragraphs; large rewrites fall back to a readable changed block. */
export function paragraphDiff(before: string, after: string): ParagraphDiff[] {
  const a = before.split(/\r?\n(?:\s*\r?\n)*/),
    b = after.split(/\r?\n(?:\s*\r?\n)*/);
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  )
    suffix++;
  const result: ParagraphDiff[] = a
    .slice(0, prefix)
    .map((text) => ({ kind: "same", text }));
  const left = a.slice(prefix, a.length - suffix),
    right = b.slice(prefix, b.length - suffix);
  if (left.length * right.length > 160000) {
    result.push(
      ...left.map((text) => ({ kind: "removed" as const, text })),
      ...right.map((text) => ({ kind: "added" as const, text })),
    );
  } else {
    const matrix = Array.from(
      { length: left.length + 1 },
      () => new Uint32Array(right.length + 1),
    );
    for (let i = left.length - 1; i >= 0; i--)
      for (let j = right.length - 1; j >= 0; j--)
        matrix[i][j] =
          left[i] === right[j]
            ? matrix[i + 1][j + 1] + 1
            : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    let i = 0,
      j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        result.push({ kind: "same", text: left[i++] });
        j++;
      } else if (
        i < left.length &&
        (j === right.length || matrix[i + 1][j] >= matrix[i][j + 1])
      )
        result.push({ kind: "removed", text: left[i++] });
      else result.push({ kind: "added", text: right[j++] });
    }
  }
  result.push(
    ...a
      .slice(a.length - suffix)
      .map((text) => ({ kind: "same" as const, text })),
  );
  return result;
}

// Structural validation is shared by portable persistence and runtime writes.
// Cross-project ownership remains the caller's responsibility.
export function validateRevisionJob(
  value: unknown,
): asserts value is RevisionJob {
  function bad(): never {
    throw new DomainError("VALIDATION", "改稿任务数据格式不正确");
  }
  function object(
    v: unknown,
    keys: string[],
  ): asserts v is Record<string, any> {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).some((k) => !keys.includes(k))
    )
      bad();
  }
  function string(v: unknown, max = 200, empty = false): asserts v is string {
    if (typeof v !== "string" || (!empty && !v.trim()) || v.length > max) bad();
  }
  function integer(
    v: unknown,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
  ): asserts v is number {
    if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) bad();
  }
  function list(v: unknown): asserts v is any[] {
    if (!Array.isArray(v) || v.length > 100000) bad();
  }
  function identifiers(v: unknown) {
    list(v);
    v.forEach((id) => string(id));
    if (new Set(v).size !== v.length) bad();
  }
  function digest(v: unknown) {
    if (typeof v !== "string" || v.length !== 64 || !/^[0-9a-f]{64}$/.test(v)) bad();
  }
  object(value, [
    "id",
    "revision",
    "createdAt",
    "updatedAt",
    "projectId",
    "profileId",
    "text",
    "scope",
    "chapterIds",
    "annotationIds",
    "selection",
    "status",
    "tokenBudget",
    "usage",
    "calls",
    "checkedChapterIds",
    "candidates",
    "notes",
    "projectPatch",
    "sourceProjectRevision",
    "sourceProjectDigest",
    "sourceAuthoringDigest",
    "sourceProfileDigest",
    "sceneSource",
    "chapterSources",
    "referenceChapterSources",
    "noteSources",
    "checkedNoteIds",
    "warnings",
    "reply",
    "error",
    "materialsStatus",
  ]);
  string(value.id);
  string(value.projectId);
  if (value.profileId !== undefined) string(value.profileId);
  integer(value.revision, 1);
  integer(value.sourceProjectRevision, 1);
  integer(value.calls);
  integer(value.tokenBudget, 1, MAX_REVISION_TOKEN_BUDGET);
  for (const field of ["createdAt", "updatedAt"]) {
    string(value[field], 100);
    if (!Number.isFinite(Date.parse(value[field]))) bad();
  }
  string(value.text, 10000);
  string(value.reply, 16000, true);
  if (value.error !== undefined) string(value.error, 2000);
  if (
    !["selection", "chapter", "chapters", "all"].includes(value.scope) ||
    ![
      "running",
      "paused",
      "interrupted",
      "cancelled",
      "failed",
      "awaiting-author",
      "completed",
    ].includes(value.status) ||
    !["pending", "accepted", "rejected"].includes(value.materialsStatus)
  )
    bad();
  for (const field of ["chapterIds", "annotationIds", "checkedChapterIds"])
    identifiers(value[field]);
  if (
    !value.chapterIds.length ||
    (value.scope === "chapter" && value.chapterIds.length !== 1) ||
    value.checkedChapterIds.some((id: string) => !value.chapterIds.includes(id))
  )
    bad();
  if (value.checkedNoteIds !== undefined) identifiers(value.checkedNoteIds);
  if (value.selection !== undefined) {
    const s = value.selection;
    object(s, ["chapterId", "revision", "start", "end", "quote"]);
    string(s.chapterId);
    integer(s.revision, 1);
    integer(s.start);
    integer(s.end, s.start + 1);
    string(s.quote, 100000);
    if (
      s.quote.length !== s.end - s.start ||
      value.scope !== "selection" ||
      value.chapterIds.length !== 1 ||
      value.chapterIds[0] !== s.chapterId
    )
      bad();
  } else if (value.scope === "selection") bad();
  if(value.sceneSource!==undefined){validateSceneSource(value.sceneSource);if(value.scope!=="selection")bad();}
  if (value.sourceProjectDigest !== undefined)
    digest(value.sourceProjectDigest);
  if (value.sourceAuthoringDigest !== undefined)
    digest(value.sourceAuthoringDigest);
  if (value.sourceProfileDigest !== undefined)
    digest(value.sourceProfileDigest);
  for (const field of [
    "chapterSources",
    "referenceChapterSources",
    "noteSources",
  ] as const)
    if (value[field] !== undefined) {
      list(value[field]);
      const fieldIds: string[] = [];
      for (const s of value[field]) {
        object(s, [
          field !== "noteSources" ? "chapterId" : "id",
          "revision",
          "digest",
        ]);
        const id = s[field !== "noteSources" ? "chapterId" : "id"];
        string(id);
        fieldIds.push(id);
        integer(s.revision, 1);
        digest(s.digest);
        if (field === "chapterSources" && !value.chapterIds.includes(id)) bad();
        if (
          field === "referenceChapterSources" &&
          value.chapterIds.includes(id)
        )
          bad();
      }
      if (
        new Set(fieldIds).size !== fieldIds.length ||
        (field === "chapterSources" &&
          fieldIds.length !== value.chapterIds.length)
      )
        bad();
    }
  list(value.candidates);
  const candidateIds: string[] = [];
  for (const c of value.candidates) {
    object(c, [
      "chapterId",
      "sourceRevision",
      "title",
      "baseContent",
      "baseTitle",
      "content",
      "status",
      "appliedRevision",
      "dependsOnChapterIds",
    ]);
    string(c.chapterId);
    integer(c.sourceRevision, 1);
    string(c.title);
    string(c.content, 100000, true);
    string(c.baseContent, 2000000, true);
    if (c.baseTitle !== undefined) string(c.baseTitle);
    if (
      !["pending", "accepted", "rejected"].includes(c.status) ||
      !value.chapterIds.includes(c.chapterId) ||
      !value.checkedChapterIds.includes(c.chapterId)
    )
      bad();
    if (c.appliedRevision !== undefined) integer(c.appliedRevision, 1);
    if (c.dependsOnChapterIds !== undefined) {
      identifiers(c.dependsOnChapterIds);
      if (
        c.dependsOnChapterIds.some(
          (id: string) =>
            id === c.chapterId ||
            !value.chapterIds.includes(id) ||
            !value.candidates.some(
              (candidate: any) => candidate.chapterId === id,
            ),
        )
      )
        bad();
    }
    candidateIds.push(c.chapterId);
  }
  if (new Set(candidateIds).size !== candidateIds.length) bad();
  list(value.notes);
  for (const n of value.notes) {
    object(n, ["id", "sourceRevision", "type", "title", "body"]);
    if (n.id !== undefined) {
      string(n.id);
      integer(n.sourceRevision, 1);
    } else if (n.sourceRevision !== undefined) bad();
    if (
      ![
        "character",
        "world",
        "location",
        "storyline",
        "outline",
        "chapterOutline",
        "summary",
        "timeline",
        "knowledge",
        "foreshadowing",
        "supplement",
      ].includes(n.type)
    )
      bad();
    string(n.title);
    string(n.body, 20000);
  }
  if (value.projectPatch !== undefined) {
    object(value.projectPatch, ["background", "genre", "style", "pace"]);
    for (const [key, v] of Object.entries(value.projectPatch))
      string(v, key === "background" ? 12000 : 500, true);
  }
  list(value.warnings);
  if (value.warnings.length > 10000) bad();
  value.warnings.forEach((w: unknown) => string(w, 2000));
  if (value.usage !== null) {
    object(value.usage, [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "estimated",
    ]);
    for (const field of ["inputTokens", "outputTokens", "totalTokens"])
      if (value.usage[field] !== null) integer(value.usage[field]);
    if (typeof value.usage.estimated !== "boolean") bad();
  }
  validatePublicJson(value);
}
