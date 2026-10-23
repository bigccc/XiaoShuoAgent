import type { ID, RecordMeta, TaskUsage } from "./types";
import { z } from "zod";
import { DomainError } from "./validation";
export type StoryKind = "event" | "location" | "condition" | "item" | "knowledge" | "relationship" | "foreshadowing";
export type StoryStatement = "fact" | "plan" | "guess" | "lie" | "recollection";
export type ForeshadowingStage = "planned" | "planted" | "progressing" | "resolved" | "abandoned";
export interface StoryEntry {
    kind: StoryKind;
    subject: string;
    attribute: string;
    value: string;
    statement: StoryStatement;
    storyTime: string;
    entityNoteId?: ID;
    foreshadowingStage?: ForeshadowingStage;
    expectedPayoff?: number;
}
export interface StoryEvidenceInput {
    chapterId: ID;
    revision: number;
    start: number;
    end: number;
}
export interface StoryEvidence extends StoryEvidenceInput {
    quote: string;
    contentHash: string;
    ordinal: number;
}
export interface StoryOrigin {
    kind: "manual" | "writing" | "extraction";
    id?: ID;
}
export interface StoryRecord extends RecordMeta, StoryEntry {
    projectId: ID;
    status: "candidate" | "confirmed" | "rejected";
    archived: boolean;
    evidence: StoryEvidence[];
    entityRevision?: number;
    origin: StoryOrigin;
    history: Omit<StoryRecord, "history">[];
    accepted?: Omit<StoryRecord, "history" | "accepted">;
}
export interface StoryProposal extends StoryEntry {
    quote: string;
}
export interface StoryRecordView extends StoryRecord {
    /** Derived reference from a checked writing run; not an author confirmation. */
    automatic?: boolean;
    needsReview: boolean;
    stable: boolean;
    sourceLabels: string[];
}
export interface StoryWorkspace {
    records: StoryRecordView[];
    current: StoryRecordView[];
    foreshadowing: StoryRecordView[];
    total: number;
    offset: number;
    nextOffset: number | null;
    blockedCount: number;
}
export interface StoryQuery {
    projectId: ID;
    beforeOrdinal?: number;
    offset?: number;
    limit?: number;
    archived?: boolean;
}
export interface StoryExtractionJob extends RecordMeta {
    projectId: ID;
    profileId?: ID;
    chapterIds: ID[];
    sources: {
        chapterId: ID;
        revision: number;
        contentHash: string;
        length: number;
    }[];
    status: "running" | "paused" | "interrupted" | "cancelled" | "failed" | "completed";
    cursor: number;
    offset: number;
    tokenBudget: number;
    budgetUsed: number;
    calls: number;
    usage: TaskUsage | null;
    candidateIds: ID[];
    reply: string;
    warnings: string[];
}
export type StoryCommand = {
    type: "story.save";
    projectId: ID;
    id?: ID;
    revision?: number;
    entry: StoryEntry;
    evidence: StoryEvidenceInput[];
} | {
    type: "story.confirm" | "story.reject" | "story.recheck";
    id: ID;
    revision: number;
} | {
    type: "story.archive";
    id: ID;
    revision: number;
    archived: boolean;
} | {
    type: "story.restore";
    id: ID;
    revision: number;
    historyRevision: number;
};
export type StoryJobStart = {
    type: "story.job.start";
    projectId: ID;
    chapterIds: ID[];
    profileId?: ID;
    tokenBudget?: number;
};
export type StoryJobCommand = StoryJobStart | {
    type: "story.job.pause" | "story.job.cancel";
    id: ID;
} | {
    type: "story.job.resume";
    id: ID;
    tokenBudget?: number;
    profileId?: ID;
};
const idSchema = z.string().min(1).max(200), revisionSchema = z.number().int().min(1);
const entryShape = { kind: z.enum(["event", "location", "condition", "item", "knowledge", "relationship", "foreshadowing"]), subject: z.string().trim().min(1).max(120), attribute: z.string().trim().min(1).max(120), value: z.string().trim().min(1).max(2000), statement: z.enum(["fact", "plan", "guess", "lie", "recollection"]), storyTime: z.string().max(120), entityNoteId: idSchema.optional(), foreshadowingStage: z.enum(["planned", "planted", "progressing", "resolved", "abandoned"]).optional(), expectedPayoff: z.number().int().min(1).optional() };
const evidenceInputShape = { chapterId: idSchema, revision: revisionSchema, start: z.number().int().min(0), end: z.number().int().min(1) };
const evidenceSchema = z.object({ ...evidenceInputShape, ordinal: revisionSchema, quote: z.string().min(1).max(4000), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().refine(e => e.end - e.start === e.quote.length);
const metaShape = { id: idSchema, revision: revisionSchema, createdAt: z.string().datetime(), updatedAt: z.string().datetime() };
const recordShape = { ...metaShape, ...entryShape, projectId: idSchema, status: z.enum(["candidate", "confirmed", "rejected"]), archived: z.boolean(), evidence: z.array(evidenceSchema).max(4), entityRevision: revisionSchema.optional(), origin: z.object({ kind: z.enum(["manual", "writing", "extraction"]), id: idSchema.optional() }).strict() };
const acceptedSchema = z.object(recordShape).strict();
const historySchema = z.object({ ...recordShape, accepted: acceptedSchema.optional() }).strict();
const recordSchema = z.object({ ...recordShape, accepted: acceptedSchema.optional(), history: z.array(historySchema).max(1000) }).strict();
const entrySchema = z.object(entryShape).strict();
const proposalSchema = z.object({ ...entryShape, quote: z.string().min(1).max(4000) }).strict();
const usageSchema = z.object({ inputTokens: z.number().int().min(0).nullable(), outputTokens: z.number().int().min(0).nullable(), totalTokens: z.number().int().min(0).nullable(), estimated: z.boolean() }).strict().nullable();
const jobSchema = z.object({ ...metaShape, projectId: idSchema, profileId: idSchema.optional(), chapterIds: z.array(idSchema).min(1).max(20), sources: z.array(z.object({ chapterId: idSchema, revision: revisionSchema, contentHash: z.string().regex(/^[a-f0-9]{64}$/), length: z.number().int().min(1) }).strict()).min(1).max(20), status: z.enum(["running", "paused", "interrupted", "cancelled", "failed", "completed"]), cursor: z.number().int().min(0), offset: z.number().int().min(0), tokenBudget: z.number().int().min(1).max(1000000), budgetUsed: z.number().int().min(0), calls: z.number().int().min(0), usage: usageSchema, candidateIds: z.array(idSchema).max(100000), reply: z.string().max(4000), warnings: z.array(z.string().max(1000)).max(100) }).strict();
function parsed<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success)
    throw new DomainError("VALIDATION", "故事状态内容或原文引用格式不正确"); return result.data; }
export function validateStoryEntry(value: unknown): asserts value is StoryEntry {
    const e = parsed(entrySchema, value);
    if (e.kind === "foreshadowing" ? !e.foreshadowingStage || (e.foreshadowingStage === "planned" && e.statement !== "plan") || (["planted", "progressing", "resolved"].includes(e.foreshadowingStage) && e.statement !== "fact") : e.foreshadowingStage !== undefined || e.expectedPayoff !== undefined)
        throw new DomainError("VALIDATION", "伏笔计划、埋设和回收须区分，并选择对应叙述性质");
}
export function validateStoryRecord(value: unknown): asserts value is StoryRecord {
    const r = parsed(recordSchema, value);
    validateStoryEntry(storyEntry(r));
    if ((r.entityNoteId === undefined) !== (r.entityRevision === undefined) || (r.statement === "fact" && !r.evidence.length) || (r.foreshadowingStage === "resolved" && r.evidence.length < 2) || r.history.some(h => h.id !== r.id || h.projectId !== r.projectId || h.revision >= r.revision))
        throw new DomainError("VALIDATION", "故事状态缺少来源、回收证据或正确历史版本");
    if (r.accepted && (r.accepted.id !== r.id || r.accepted.projectId !== r.projectId || r.accepted.revision > r.revision || r.accepted.status !== "confirmed"))
        throw new DomainError("VALIDATION", "采纳状态快照不正确");
    for (const frame of [r, r.accepted, ...r.history, ...r.history.map(h => h.accepted)].filter(Boolean)) {
        validateStoryEntry(storyEntry(frame!));
        if (frame!.id !== r.id || frame!.projectId !== r.projectId || frame!.revision > r.revision || (frame!.entityNoteId === undefined) !== (frame!.entityRevision === undefined) || frame!.statement === "fact" && !frame!.evidence.length || frame!.foreshadowingStage === "resolved" && (frame!.evidence.length < 2 || frame!.evidence[0].ordinal > frame!.evidence.at(-1)!.ordinal || frame!.evidence[0].chapterId === frame!.evidence.at(-1)!.chapterId && frame!.evidence[0].start >= frame!.evidence.at(-1)!.start))
            throw new DomainError("VALIDATION", "故事状态历史或采纳快照缺少证据");
    }
    if (new Set(r.history.map(h => h.revision)).size !== r.history.length || r.history.some((h, i) => i > 0 && h.revision <= r.history[i - 1].revision))
        throw new DomainError("VALIDATION", "状态历史版本顺序不正确");
}
export function storyEntry(record: StoryEntry): StoryEntry { return Object.fromEntries(Object.keys(entryShape).filter(k => (record as any)[k] !== undefined).map(k => [k, (record as any)[k]])) as unknown as StoryEntry; }
export function validateStoryJob(value: unknown): asserts value is StoryExtractionJob {
    const j = parsed(jobSchema, value);
    if (j.sources.length !== j.chapterIds.length || j.sources.some((s, i) => s.chapterId !== j.chapterIds[i]) || new Set(j.chapterIds).size !== j.chapterIds.length || j.cursor > j.sources.length || j.status === "completed" && j.cursor !== j.sources.length || j.cursor < j.sources.length && j.offset >= j.sources[j.cursor].length)
        throw new DomainError("VALIDATION", "状态提取任务进度或来源不正确");
}
export function validateStoryProposal(value: unknown): asserts value is StoryProposal { const p = parsed(proposalSchema, value); const { quote, ...entry } = p; validateStoryEntry(entry); }
export function validateStoryCommand(value: unknown): asserts value is StoryCommand {
    const existing = { id: idSchema, revision: revisionSchema };
    const schema = z.discriminatedUnion("type", [
        z.object({ type: z.literal("story.save"), projectId: idSchema, id: idSchema.optional(), revision: revisionSchema.optional(), entry: entrySchema, evidence: z.array(z.object(evidenceInputShape).strict()).max(4) }).strict(),
        ...["story.confirm", "story.reject", "story.recheck"].map(type => z.object({ type: z.literal(type), ...existing }).strict()),
        z.object({ type: z.literal("story.archive"), ...existing, archived: z.boolean() }).strict(),
        z.object({ type: z.literal("story.restore"), ...existing, historyRevision: revisionSchema }).strict(),
    ]);
    parsed(schema, value);
}
export function validateStoryJobCommand(value: unknown): asserts value is StoryJobCommand {
    parsed(z.discriminatedUnion("type", [
        z.object({ type: z.literal("story.job.start"), projectId: idSchema, chapterIds: z.array(idSchema).min(1).max(20), profileId: idSchema.optional(), tokenBudget: z.number().int().min(1).max(1000000).optional() }).strict(),
        z.object({ type: z.literal("story.job.pause"), id: idSchema }).strict(), z.object({ type: z.literal("story.job.cancel"), id: idSchema }).strict(),
        z.object({ type: z.literal("story.job.resume"), id: idSchema, profileId: idSchema.optional(), tokenBudget: z.number().int().min(1).max(1000000).optional() }).strict(),
    ]), value);
}
