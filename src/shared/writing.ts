import type { ID, RecordMeta, SourceRevision, TaskUsage } from "./types";
import { DomainError, validatePublicJson, validateSources } from "./validation";
import { validateRecallReferences, type RecallReference } from "./recall";

export const DEFAULT_WRITING_TOKEN_BUDGET = 100000;
export const MAX_WRITING_TOKEN_BUDGET = 1_000_000_000;

export interface WritingGoal {
  kind: "through" | "append";
  startOrdinal: number;
  endOrdinal: number;
}

export interface WritingChapterProgress {
  ordinal: number;
  chapterId?: ID;
  existing: boolean;
  status: "pending" | "written" | "checked" | "needs-review";
  revisionRounds: number;
  checkedRevision?: number;
  savedRevision?: number;
}

export interface WritingIssue {
  category: "character" | "timeline" | "plot" | "world" | "knowledge" | "foreshadowing" | "style" | "pacing" | "length";
  impact: "blocking" | "local";
  reason: string;
  evidence: { quote: string; source: SourceRevision }[];
  chapterId?: ID;
}

export interface WritingJob extends RecordMeta {
  projectId: ID;
  profileId?: ID;
  mode?: "quick" | "thorough";
  checkCacheHits?: number;
  checkCacheMisses?: number;
  checkingProfileId?: ID;
  text: string;
  goal: WritingGoal;
  status: "running" | "paused" | "interrupted" | "cancelled" | "failed" | "awaiting-author" | "completed";
  phase: "planning" | "writing" | "checking" | "revising" | "reviewing" | "done";
  chapters: WritingChapterProgress[];
  cursor: number;
  plan: string;
  planningDone: boolean;
  reviewCursor: number;
  reviewRounds: number;
  reviewSourceDigest?: string;
  checkCursor?: number;
  checkSourceDigest?: string;
  checkIssues?: WritingIssue[];
  issues: WritingIssue[];
  revisionJobIds: ID[];
  warnings: string[];
  contextReferences?: RecallReference[];
  contextReferenceCall?: { number: number; phase: string; ordinal?: number };
  tokenBudget: number;
  budgetUsed: number;
  usage: TaskUsage | null;
  calls: number;
  reply: string;
  error?: string;
}

export type WritingCommand =
  | { type: "writing.start"; projectId: ID; text: string; goal: WritingGoal; profileId?: ID; tokenBudget: number; mode?: "quick" | "thorough" }
  | { type: "writing.pause" | "writing.cancel"; id: ID }
  | { type: "writing.resume"; id: ID; tokenBudget?: number; profileId?: ID; text?: string };

const numberText = "[零〇一二两三四五六七八九十百\\d]+";
const nonExecution = /讨论|聊聊|分析|如何|怎么|是否|要不要|如果|假如|试写|试试看|想想|解释|举例|(?:不要|先不|暂不|先别|别|不用|不必)(?:执行|启动|开始写|动笔)|[“”「」『』"]/;
const globalNonExecution = /如果|假如|试写|试试看|(?:不要|先不|暂不|先别|别|不用|不必)(?:执行|启动|开始写|动笔)|[“”「」『』"]/;
const deniedExecution = /不要|别|不必|不用|暂不|先不|不想|不需要|等.*再/;
const revisionOnly = /改写|修改|重写|润色|调整|检查|审阅/;
const clauses = (text: string) => text.split(/[，。；,;\n]|但是|然后/).map(clause => clause.replace(/\s/g, ""));
function count(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digit: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "百" || value === "一百") return 100;
  if (value.length === 1 && value in digit) return digit[value];
  const match = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(value);
  return match ? (match[1] ? digit[match[1]] : 1) * 10 + (match[2] ? digit[match[2]] : 0) : NaN;
}

/** Detect only a concrete execution request; ambiguous scopes never default to one chapter. */
export function detectWritingGoal(text: string, lastOrdinal: number): WritingGoal | null {
  if (typeof text !== "string" || text.length > 10000 || !Number.isSafeInteger(lastOrdinal) || lastOrdinal < 0) return null;
  if (globalNonExecution.test(text) || /还是|或者|[?？]/.test(text)) return null;
  const goals: WritingGoal[] = [];
  for (const clause of clauses(text)) {
    if (!clause || nonExecution.test(clause)) continue;
    const hasScope = new RegExp(`(?:前${numberText}章|第${numberText}(?:章)?(?:到|至|[-—])第?${numberText}章|(?:连续写|接着写|连写|续写)${numberText}章)`).test(clause);
    if (hasScope && (deniedExecution.test(clause) || revisionOnly.test(clause))) return null;
    let kind: WritingGoal["kind"] = "through", end: number | undefined;
    const prefix = "^(?:请|请你|帮我|帮忙|麻烦你?|替我|给我|我要你|我想让你)*(?:一口气)?(?:把|将)?";
    const ending = "(?:吧|好吗|可以吗)?[！!]*$";
    const throughBefore = new RegExp(`${prefix}(?:写完|完成|补齐|补完|写)(?:前|到第)(${numberText})章(?:正文)?${ending}`).exec(clause);
    const throughAfter = new RegExp(`${prefix}前(${numberText})章(?:的正文|正文)?(?:都|全部)?(?:写完|完成|补齐|补完)${ending}`).exec(clause);
    const throughTo = new RegExp(`${prefix}(?:这本书|本书|故事|小说|正文|作品)?(?:写|续写|补齐)到第?(${numberText})章${ending}`).exec(clause);
    const range = new RegExp(`${prefix}(?:完成|写完|补齐)第?(${numberText})(?:章)?(?:到|至|[-—])第?(${numberText})章${ending}`).exec(clause);
    const append = new RegExp(`${prefix}(?:连续写|接着写|连写|续写|再写|一口气写)(${numberText})章(?:正文)?${ending}`).exec(clause)
      ?? (clause.includes("一口气") ? new RegExp(`${prefix}写(${numberText})章(?:正文)?${ending}`).exec(clause) : null);
    if (throughBefore || throughAfter || throughTo) end = count((throughBefore ?? throughAfter ?? throughTo)![1]);
    else if (range && count(range[1]) === 1) end = count(range[2]);
    else if (append) { kind = "append"; end = lastOrdinal + count(append[1]); }
    else continue;
    const startOrdinal = kind === "append" ? lastOrdinal + 1 : 1;
    if (!Number.isSafeInteger(end) || end! < startOrdinal || end! - startOrdinal + 1 > 100) return null;
    goals.push({ kind, startOrdinal, endOrdinal: end! });
  }
  return goals.length === 1 ? goals[0] : null;
}

/** A bounded writer must clarify unsupported execution wording instead of falling back to one chapter. */
export function hasUnresolvedWritingGoal(text: string): boolean {
  if (typeof text !== "string" || text.length > 10000 || globalNonExecution.test(text) || detectWritingGoal(text, 0)) return false;
  return clauses(text).some(clause => {
    if (nonExecution.test(clause) || !/写|创作|完成|补齐|补完/.test(clause) || deniedExecution.test(clause) || revisionOnly.test(clause)) return false;
    if (new RegExp(`第?${numberText}(?:章)?(?:到|至|[-—])第?${numberText}章`).test(clause)) return true;
    if (new RegExp(`(?:写|创作|完成|补齐|补完)到第?${numberText}章`).test(clause)) return true;
    // “第十五章” names one chapter; “十五章” and “前十五章” name a multi-chapter goal.
    return [...clause.matchAll(new RegExp(`(第)?(${numberText}|几|数|多|若干)章`, "g"))]
      .some(match => !match[1] && count(match[2]) !== 1);
  });
}
function fail(): never { throw new DomainError("VALIDATION", "连续写作任务数据格式不正确"); }
function object(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function string(value: unknown, max: number, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) fail();
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail();
}
function array(value: unknown, max: number): asserts value is any[] {
  if (!Array.isArray(value) || value.length > max) fail();
}

export function validateWritingJob(value: unknown): asserts value is WritingJob {
  object(value, ["id", "revision", "createdAt", "updatedAt", "projectId", "profileId", "checkingProfileId", "text", "goal", "status", "phase", "chapters", "cursor", "plan", "planningDone", "reviewCursor", "reviewRounds", "reviewSourceDigest", "checkCursor", "checkSourceDigest", "checkIssues", "issues", "revisionJobIds", "warnings", "contextReferences", "contextReferenceCall", "tokenBudget", "budgetUsed", "usage", "calls", "reply", "error", "mode", "checkCacheHits", "checkCacheMisses"]);
  for (const key of ["id", "projectId"]) string(value[key], 200);
  for (const key of ["profileId", "checkingProfileId"]) if (value[key] !== undefined) string(value[key], 200);
  integer(value.revision, 1);
  for (const key of ["createdAt", "updatedAt"]) {
    string(value[key], 100);
    if (!Number.isFinite(Date.parse(value[key]))) fail();
  }
  if(value.mode!==undefined&&!["quick","thorough"].includes(value.mode))fail();
  for(const field of ["checkCacheHits","checkCacheMisses"])if(value[field]!==undefined)integer(value[field],0);
  string(value.text, 10000); string(value.plan, 40000, true); string(value.reply, 12000, true);
  if (value.error !== undefined) string(value.error, 4000, true);
  object(value.goal, ["kind", "startOrdinal", "endOrdinal"]);
  const goal = value.goal;
  if (!["through", "append"].includes(goal.kind)) fail();
  integer(goal.startOrdinal, 1); integer(goal.endOrdinal, goal.startOrdinal);
  const length = goal.endOrdinal - goal.startOrdinal + 1;
  if (length > 100 || (goal.kind === "through" && goal.startOrdinal !== 1)) fail();
  if (!["running", "paused", "interrupted", "cancelled", "failed", "awaiting-author", "completed"].includes(value.status) || !["planning", "writing", "checking", "revising", "reviewing", "done"].includes(value.phase)) fail();
  array(value.chapters, 100);
  if (value.chapters.length !== length) fail();
  const chapterIds = new Set<string>();
  for (const [index, chapter] of value.chapters.entries()) {
    object(chapter, ["ordinal", "chapterId", "existing", "status", "revisionRounds", "checkedRevision", "savedRevision"]);
    if (chapter.ordinal !== goal.startOrdinal + index || typeof chapter.existing !== "boolean" || !["pending", "written", "checked", "needs-review"].includes(chapter.status)) fail();
    if (chapter.chapterId !== undefined) {
      string(chapter.chapterId, 200);
      if (chapterIds.has(chapter.chapterId)) fail();
      chapterIds.add(chapter.chapterId);
    } else if (chapter.existing || chapter.status !== "pending") fail();
    integer(chapter.revisionRounds, 0, 2);
    if (chapter.checkedRevision !== undefined) integer(chapter.checkedRevision, 1);
    if (chapter.savedRevision !== undefined) integer(chapter.savedRevision, 1);
  }
  integer(value.cursor, 0, length); integer(value.reviewCursor, 0, 100000); integer(value.reviewRounds, 0, 200);
  if (value.checkCursor !== undefined) integer(value.checkCursor, 0, 100000);
  for (const field of ["reviewSourceDigest", "checkSourceDigest"])
    if (value[field] !== undefined && (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/i.test(value[field]))) fail();
  if (typeof value.planningDone !== "boolean") fail();
  if (value.status === "completed" && (value.phase !== "done" || !value.planningDone || value.cursor !== length || value.chapters.some(chapter => chapter.status !== "checked"))) fail();
  if (value.contextReferences !== undefined) validateRecallReferences(value.contextReferences);
  if (value.contextReferenceCall !== undefined) {
    object(value.contextReferenceCall,["number","phase","ordinal"]);
    integer(value.contextReferenceCall.number,1,value.calls);
    if (!["规划","生成","修订","检查","检查整理","跨章复核"].includes(value.contextReferenceCall.phase)) fail();
    if(value.contextReferenceCall.ordinal!==undefined)integer(value.contextReferenceCall.ordinal,1);
    if(!value.contextReferences?.length)fail();
  }
  array(value.issues, 1000);
  if (value.checkIssues !== undefined) array(value.checkIssues, 1000);
  if (value.status === "completed" && value.issues.length) fail();
  for (const issue of [...value.issues, ...(value.checkIssues ?? [])]) {
    object(issue, ["category", "impact", "reason", "evidence", "chapterId"]);
    if (!["character", "timeline", "plot", "world", "knowledge", "foreshadowing", "style", "pacing", "length"].includes(issue.category) || !["blocking", "local"].includes(issue.impact)) fail();
    string(issue.reason, 4000);
    if (issue.chapterId !== undefined) string(issue.chapterId, 200);
    array(issue.evidence, 20);
    for (const evidence of issue.evidence) {
      object(evidence, ["quote", "source"]); string(evidence.quote, 12000);
      object(evidence.source, ["kind", "id", "revision"]);
      validateSources([evidence.source]); string(evidence.source.id, 200);
    }
  }
  for (const key of ["revisionJobIds", "warnings"]) {
    array(value[key], 1000);
    value[key].forEach((item: unknown) => string(item, key === "warnings" ? 4000 : 200));
  }
  if (new Set(value.revisionJobIds).size !== value.revisionJobIds.length) fail();
  integer(value.tokenBudget, 1, MAX_WRITING_TOKEN_BUDGET); integer(value.budgetUsed); integer(value.calls);
  if (value.usage !== null) {
    object(value.usage, ["inputTokens", "outputTokens", "totalTokens", "estimated"]);
    if (typeof value.usage.estimated !== "boolean") fail();
    for (const key of ["inputTokens", "outputTokens", "totalTokens"]) if (value.usage[key] !== null) integer(value.usage[key]);
  }
  validatePublicJson(value);
}
